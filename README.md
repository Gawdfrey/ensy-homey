# Ensy Homey

A Homey Pro app for connecting to Ensy ventilation devices.

## Features

- **Climate Control**: Full thermostat functionality with temperature control (15-26°C)
- **Fan Control**: Three-speed fan control (Low/Medium/High)
- **Preset Modes**: Home, Away, and Boost modes
- **Temperature Monitoring**: Multiple temperature sensors
  - Extract air temperature
  - Exhaust air temperature
  - Outside air temperature
  - Heater temperature
  - Supply air temperature (used as room temperature)
- **Heating Status**: Real-time heating indicator
- **Flow Cards**: Complete Homey Flow integration
  - Actions: Set preset mode
  - Conditions: Is heating, Preset mode checks
  - Triggers: Heating started/stopped, Preset mode changed

## Installation

1. Install the app on your Homey Pro
2. Add a new device and select "Ensy Ventilation Unit"
3. Enter your device's MAC address
4. Enable "Allow Insecure TLS" if needed (for devices with expired certificates)

## Technical Details

This app connects to Ensy devices via MQTT over WebSockets using the same protocol as the official Ensy app:
- Endpoint: `app.ensy.no:8083/mqtt`
- Authentication: MAC address-based
- Protocol: MQTT over WebSockets with TLS

Based on the [ensy-home-assistant](https://github.com/alexbrasetvik/ensy-home-assistant/) Python service.

## MAC Address Discovery

Ensy devices typically use MAC addresses starting with:
- `34AB95*` 
- `C4DEE2*`

You can find your device's MAC address in your router's DHCP client list or by checking the device label.

## License

MIT License - see LICENSE file for details.

## Contributing

Pull requests are welcome! Please ensure all changes maintain compatibility with the existing Ensy MQTT protocol.