using System.Runtime.InteropServices;
using System.Text;

namespace DevShift.Windows;

internal sealed record PowerPlan(Guid Id, string Name);
internal sealed record PowerState(Guid Active, PowerPlan[] Plans);

internal static class Power
{
    private const uint AccessScheme = 16;
    private const uint NoMoreItems = 259;

    internal static PowerState Scan()
    {
        var active = Active();
        var plans = new List<PowerPlan>();
        for (uint index = 0; index < 256; index++)
        {
            uint size = 16;
            var result = PowerEnumerate(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, AccessScheme, index, out var plan, ref size);
            if (result == NoMoreItems) break;
            Check(result, "list");
            plans.Add(new(plan, Name(plan)));
        }

        return new(active, [.. plans]);
    }

    internal static object Change(Guid before, Guid after)
    {
        var current = Active();
        if (current == after) return new { changed = false };
        if (current != before)
            throw new WindowsFault("state-changed", "The active power plan changed in Windows.");
        if (!Scan().Plans.Any(plan => plan.Id == after))
            throw new WindowsFault("plan-missing", "The selected power plan is unavailable.");

        Check(PowerSetActiveScheme(IntPtr.Zero, ref after), "apply");
        if (Active() != after)
            throw new WindowsFault("verify-power", "Windows did not report the requested active power plan.");
        return new { changed = true };
    }

    private static Guid Active()
    {
        Check(PowerGetActiveScheme(IntPtr.Zero, out var address), "read");
        try { return Marshal.PtrToStructure<Guid>(address); }
        finally { Inventory.LocalFree(address); }
    }

    private static string Name(Guid plan)
    {
        uint size = 0;
        var result = PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, null, ref size);
        if ((result != 0 && result != 234) || size is 0 or > 8192) return plan.ToString();
        var bytes = new byte[size];
        return PowerReadFriendlyName(IntPtr.Zero, ref plan, IntPtr.Zero, IntPtr.Zero, bytes, ref size) == 0
            ? Encoding.Unicode.GetString(bytes).TrimEnd('\0')
            : plan.ToString();
    }

    private static void Check(uint result, string operation)
    {
        if (result != 0)
            throw new WindowsFault("power-" + operation, $"Windows could not {operation} the power plan (error {result}).");
    }

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr plan);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerSetActiveScheme(IntPtr root, ref Guid plan);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerEnumerate(
        IntPtr root, IntPtr plan, IntPtr subgroup, uint accessor, uint index, out Guid buffer, ref uint size);

    [DllImport("powrprof.dll", ExactSpelling = true)]
    private static extern uint PowerReadFriendlyName(
        IntPtr root, ref Guid plan, IntPtr subgroup, IntPtr settings, [Out] byte[]? buffer, ref uint size);
}
