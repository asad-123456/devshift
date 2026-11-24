using System.ComponentModel;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DevShift.Windows;

internal sealed class WindowsFault(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal static partial class Program
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [GeneratedRegex("^[a-zA-Z0-9_$.-]{1,100}$", RegexOptions.CultureInvariant)]
    private static partial Regex ServiceName();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Digest();

    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args is ["monitor"]) return SystemPerformance.Monitor(Json);
            object? value = args switch
            {
                ["scan"] => new
                {
                    processes = Inventory.Processes(),
                    services = Services.Scan(),
                    power = Power.Scan(),
                    installed = Inventory.Installed(),
                    build = Environment.OSVersion.Version.Build
                },
                ["scan-live"] => new
                {
                    processes = Inventory.Processes(),
                    services = Services.Scan(),
                    power = Power.Scan(),
                    installed = Array.Empty<InstalledTool>(),
                    build = Environment.OSVersion.Version.Build
                },
                ["process", var pid] when int.TryParse(pid, out int processId) && processId > 0
                    => Inventory.Processes(processId).FirstOrDefault(),
                ["service", var action, var name, var digest, var expectedPid]
                    when action is "start" or "stop" && ServiceName().IsMatch(name) && Digest().IsMatch(digest)
                    && int.TryParse(expectedPid, out var id) && id >= 0
                    => Services.Change(action, name, digest, id),
                ["power", var before, var after] when Guid.TryParseExact(before, "D", out var oldPlan)
                    && Guid.TryParseExact(after, "D", out var newPlan) => Power.Change(oldPlan, newPlan),
                _ => throw new WindowsFault("invalid-request", "Windows helper rejected the request.")
            };
            Console.WriteLine(JsonSerializer.Serialize(new { ok = true, value }, Json));
            return 0;
        }
        catch (IOException) when (args is ["monitor"])
        {
            return 0;
        }
        catch (WindowsFault fault)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { ok = false, code = fault.Code, message = fault.Message }, Json));
            return 1;
        }
        catch (Exception exception)
        {
            var code = exception is Win32Exception win32 ? win32.NativeErrorCode : exception.HResult;
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                ok = false,
                code = "windows-error",
                message = $"Windows returned error {code}."
            }, Json));
            return 1;
        }
    }
}
