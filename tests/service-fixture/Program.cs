using System.ServiceProcess;
using System.Text.RegularExpressions;

if (args is not [var name] || !Regex.IsMatch(name, @"^postgresql-x64-\d{8,9}$"))
    return 1;

using var service = new FixtureService(name);
ServiceBase.Run(service);
return 0;

sealed class FixtureService : ServiceBase
{
    internal FixtureService(string name)
    {
        ServiceName = name;
        CanStop = true;
        AutoLog = false;
    }
}
