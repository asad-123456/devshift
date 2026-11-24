using System.ComponentModel;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace DevShift.Windows;

internal sealed record ServiceLink(string Name, string State);
internal sealed record ServiceInfo(
    string Name, string Label, string State, int Pid, string? Path, string Fingerprint,
    bool Supported, bool CanControl, bool AcceptStop, string? Limitation, ServiceLink[] Requires, ServiceLink[] Dependents);

internal static partial class Services
{
    private const uint Connect = 0x0001;
    private const uint QueryStatus = 0x0004;
    private const uint StartStop = 0x0030;

    [GeneratedRegex(@"^(?:MSSQL(?:SERVER|\$[a-z0-9_]+)|SQLAgent\$[a-z0-9_]+|SQLSERVERAGENT|postgresql(?:-x64)?-\d+(?:\.\d+)?|mysql(?:\d+)?|mariadb(?:\d+)?|mongodb(?:\d+)?|redis(?:-windows)?|memurai)(?:\.exe)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DatabaseServiceName();

    [GeneratedRegex(@"^(?:com\.docker\.service|WslService|LxssManager)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex InfrastructureName();

    internal static ServiceInfo[] Scan()
    {
        using var manager = OpenSCManagerW(null, null, Connect);
        using var searcher = new ManagementObjectSearcher("SELECT Name, DisplayName, State, ProcessId, PathName, ServiceType, StartMode, StartName, AcceptStop FROM Win32_Service");
        using var rows = Inventory.Query(searcher);
        var result = new List<ServiceInfo>();
        foreach (ManagementObject row in rows)
        {
            using (row)
            {
                var name = (string)row["Name"];
                if (DatabaseServiceName().IsMatch(name) || InfrastructureName().IsMatch(name))
                    result.Add(Read(row, manager));
            }
        }

        return [.. result.OrderBy(service => service.Name, StringComparer.OrdinalIgnoreCase)];
    }

    internal static object Change(string action, string name, string fingerprint, int expectedPid)
    {
        if (!DatabaseServiceName().IsMatch(name))
            throw new WindowsFault("unsupported-service", "This service is outside the supported database service list.");

        using var manager = OpenSCManagerW(null, null, Connect);
        using var searcher = new ManagementObjectSearcher(
            $"SELECT Name, DisplayName, State, ProcessId, PathName, ServiceType, StartMode, StartName, AcceptStop FROM Win32_Service WHERE Name = '{name}'");
        using var rows = Inventory.Query(searcher);
        using var row = rows.Cast<ManagementObject>().FirstOrDefault();
        if (row is null) throw new WindowsFault("service-missing", "The service is no longer installed.");
        var service = Read(row, manager);
        if (!service.Supported || service.Fingerprint != fingerprint)
            throw new WindowsFault("service-changed", "The service configuration changed or can no longer be verified.");
        if (!service.CanControl)
            throw new WindowsFault("service-access", "Windows denied start and stop access to this service.");

        var stop = action == "stop";
        var desired = stop ? "stopped" : "running";
        if (service.State == desired) return new { changed = false };
        if (stop && (service.State != "running" || service.Pid <= 0 || service.Pid != expectedPid || !service.AcceptStop))
            throw new WindowsFault("state-changed", "The service instance changed or does not accept a graceful stop.");
        if (!stop && service.State != "stopped")
            throw new WindowsFault("state-changed", "The service is in a pending or paused state.");
        if (stop && service.Dependents.Any(link => link.State != "stopped"))
            throw new WindowsFault("service-dependent", "An active dependent service prevents the stop.");
        if (!stop && service.Requires.Any(link => link.State != "running"))
            throw new WindowsFault("service-prerequisite", "A required service is unavailable. DevShift left it unchanged.");

        using var controller = new ServiceController(service.Name);
        try
        {
            if (stop) controller.Stop(stopDependentServices: false);
            else controller.Start();

            var status = stop ? ServiceControllerStatus.Stopped : ServiceControllerStatus.Running;
            controller.WaitForStatus(status, TimeSpan.FromSeconds(16));
            controller.Refresh();
            if (controller.Status != status)
                throw new WindowsFault("service-verify", "Windows did not report the expected service state.");
        }
        catch (System.ServiceProcess.TimeoutException)
        {
            throw new WindowsFault("service-timeout", "The service did not reach the expected state before the timeout.");
        }
        catch (InvalidOperationException error) when (error.InnerException is Win32Exception native)
        {
            throw new WindowsFault("service-control", $"Windows rejected service control (error {native.NativeErrorCode}).");
        }

        return new { changed = true };
    }

    private static ServiceInfo Read(ManagementObject row, ServiceHandle manager)
    {
        var name = (string)row["Name"];
        var image = (string?)row["PathName"] ?? "";
        var path = Inventory.Arguments(image)?.FirstOrDefault();
        var state = State((string)row["State"]);
        var pid = Convert.ToInt32(row["ProcessId"]);
        var startMode = row["StartMode"] as string;
        var type = row["ServiceType"] as string;
        var supported = DatabaseServiceName().IsMatch(name)
            && type == "Own Process"
            && startMode != "Disabled"
            && path is not null && IsExpectedImage(name, path);
        string? limitation = supported ? null : InfrastructureName().IsMatch(name)
            ? "Infrastructure service. Its workloads may include unrelated sessions."
            : "The service image, type, or start setting is outside the supported policy.";

        ServiceLink[] requires = [];
        ServiceLink[] dependents = [];
        if (supported)
        {
            try
            {
                using var controller = new ServiceController(name);
                requires = Links(controller.ServicesDependedOn);
                dependents = Links(controller.DependentServices);
            }
            catch (Exception error) when (error is InvalidOperationException or Win32Exception or ArgumentException)
            {
                supported = false;
                limitation = "Windows did not expose a complete dependency graph.";
            }
        }

        var canControl = false;
        if (supported && !manager.IsInvalid)
        {
            using var service = OpenServiceW(manager, name, QueryStatus | StartStop);
            canControl = !service.IsInvalid;
        }

        if (supported && !canControl) limitation = "Windows start and stop permissions are required.";
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\0',
            name.ToLowerInvariant(), image, startMode, type, row["StartName"] as string,
            string.Join(',', requires.Select(link => link.Name))))));
        return new(name, (string?)row["DisplayName"] ?? name, state, pid,
            path is not null && Path.IsPathFullyQualified(path) ? path : null,
            digest, supported, canControl, row["AcceptStop"] is true, limitation, requires, dependents);
    }

    private static bool IsExpectedImage(string service, string path)
    {
        if (path.Length < 4 || !char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\'
            || !Path.IsPathFullyQualified(path)) return false;
        var file = Path.GetFileName(path).ToLowerInvariant();
        return service.ToLowerInvariant() switch
        {
            var name when name.StartsWith("mssql", StringComparison.Ordinal) => file == "sqlservr.exe",
            var name when name.StartsWith("sql", StringComparison.Ordinal) => file == "sqlagent.exe",
            var name when name.StartsWith("postgresql", StringComparison.Ordinal) => file is "pg_ctl.exe" or "postgres.exe",
            var name when name.StartsWith("mysql", StringComparison.Ordinal) => file == "mysqld.exe",
            var name when name.StartsWith("mariadb", StringComparison.Ordinal) => file is "mariadbd.exe" or "mysqld.exe",
            var name when name.StartsWith("mongodb", StringComparison.Ordinal) => file == "mongod.exe",
            var name when name.StartsWith("redis", StringComparison.Ordinal) => file == "redis-server.exe",
            "memurai" => file == "memurai.exe",
            _ => false
        };
    }

    private static ServiceLink[] Links(ServiceController[] controllers)
    {
        try
        {
            return [.. controllers.Select(controller => new ServiceLink(
                controller.ServiceName, State(controller.Status.ToString()))).OrderBy(link => link.Name, StringComparer.OrdinalIgnoreCase)];
        }
        finally
        {
            foreach (var controller in controllers) controller.Dispose();
        }
    }

    private static string State(string value) => value.Replace(" ", "").ToLowerInvariant();

    private sealed class ServiceHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private ServiceHandle() : base(true) { }
        protected override bool ReleaseHandle() => CloseServiceHandle(handle);
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern ServiceHandle OpenSCManagerW(string? machine, string? database, uint access);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern ServiceHandle OpenServiceW(ServiceHandle manager, string name, uint access);

    [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr handle);
}
