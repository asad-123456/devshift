using System.Runtime.InteropServices;
using System.Text.Json;

namespace DevShift.Windows;

internal sealed class SystemPerformance : IDisposable
{
    private const string ProcessorTime = @"\Processor Information(_Total)\% Processor Time";
    private const uint FormatDouble = 0x200;
    private nint query;
    private nint counter;
    private long? lastCollection;
    private long retryAfter;

    [StructLayout(LayoutKind.Explicit)]
    private struct CounterValue
    {
        [FieldOffset(0)] public uint Status;
        [FieldOffset(8)] public double Value;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, Load;
        public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile;
        public ulong TotalVirtual, AvailableVirtual, AvailableExtendedVirtual;
    }

    [DllImport("pdh.dll", ExactSpelling = true)]
    private static extern uint PdhOpenQueryW(nint source, nuint userData, out nint query);

    [DllImport("pdh.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint PdhAddEnglishCounterW(nint query, string path, nuint userData, out nint counter);

    [DllImport("pdh.dll")]
    private static extern uint PdhCollectQueryData(nint query);

    [DllImport("pdh.dll")]
    private static extern uint PdhGetFormattedCounterValue(nint counter, uint format, nint type, out CounterValue value);

    [DllImport("pdh.dll")]
    private static extern uint PdhCloseQuery(nint query);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    private bool Collect()
    {
        if (query == 0 && PdhOpenQueryW(0, 0, out query) != 0) return false;
        if (counter == 0 && PdhAddEnglishCounterW(query, ProcessorTime, 0, out counter) != 0) return false;
        return PdhCollectQueryData(query) == 0;
    }

    private double? ReadCpu()
    {
        var now = Environment.TickCount64;
        if (now < retryAfter) return null;
        if (!Collect())
        {
            Dispose();
            retryAfter = now + 5000;
            return null;
        }

        var previous = lastCollection;
        lastCollection = now;
        if (previous is null || now - previous > 2500) return null;
        var result = PdhGetFormattedCounterValue(counter, FormatDouble, 0, out var value);
        return result == 0 && value.Status <= 1 && double.IsFinite(value.Value) && value.Value is >= 0 and <= 100
            ? value.Value : null;
    }

    public static int Monitor(JsonSerializerOptions json)
    {
        using var performance = new SystemPerformance();
        while (Console.ReadLine() == string.Empty)
        {
            var cpu = performance.ReadCpu();
            var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
            var valid = GlobalMemoryStatusEx(ref memory) && memory.TotalPhysical > 0 && memory.AvailablePhysical <= memory.TotalPhysical;
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                sampledAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                cpu,
                usedMemory = valid ? memory.TotalPhysical - memory.AvailablePhysical : (ulong?)null,
                totalMemory = valid ? memory.TotalPhysical : (ulong?)null
            }, json));
        }
        return 0;
    }

    public void Dispose()
    {
        if (query != 0) PdhCloseQuery(query);
        query = 0;
        counter = 0;
        lastCollection = null;
    }
}
