local net = require "luci.model.network"

local m = Map("netstats", translate("Netstat"),
    translate("Select your preferred primary WAN interface."))

-- Actual config section, with a title
local s = m:section(TypedSection, "config", translate("Settings"))
s.anonymous = true

local iface = s:option(ListValue, "prefer", translate("WAN Interface"))
iface.description = translate(
    "Choose the interface used to detect WAN traffic. " ..
    "Leave it as Auto detect unless you want to override. " ..
    "In case Auto detect selects the wrong interface, please use manual configuration."
)

local netm = net.init()
local devs = netm:get_interfaces()

iface:value("", translate("Auto detect (recommended)"))

for _, dev in ipairs(devs) do
    local name = dev:shortname()
    if name and not name:match("^lan%d?$") and not name:match("^br%-") and not name:match("^lo$") then
        iface:value(name)
    end
end

return m
