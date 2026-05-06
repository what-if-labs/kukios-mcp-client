#!/usr/bin/env python3
"""
KūkiOS MCP Client - Python Example
"""

from kukios_mcp_client import KukiOSClient

# Initialize client
client = KukiOSClient(
    url="https://dashbeta.what-if.sg",
    email="your@email.com",
    password="your-password"
)

# List all devices
print("=== Listing Devices ===")
devices = client.list_devices()
print(f"Found {len(devices)} devices\n")

for device in devices:
    print(f"Device: {device.get('name')}")
    print(f"  ID: {device.get('id')}")
    print(f"  Building: {device.get('building_id')}")
    print()

# Get IAQ health score for first device
if devices:
    device_id = devices[0]['id']
    print(f"=== IAQ Health Score for {devices[0].get('name')} ===")
    health = client.get_iaq_health_score(device_id)
    print(f"Score: {health['health_score']}/100")
    print(f"Grade: {health['grade']}")
    print(f"Message: {health['message']}")
    print()
    
    # Get latest readings
    print("=== Latest Readings ===")
    readings = client.get_latest_readings(device_id)
    if readings.get('readings'):
        latest = readings['readings'][0]
        print(f"Temperature: {latest.get('temperature')}°C")
        print(f"Humidity: {latest.get('humidity')}%")
        print(f"PM2.5: {latest.get('pm25')} µg/m³")
        print(f"CO2: {latest.get('co2')} ppm")
        print(f"TVOC: {latest.get('tvoc')} µg/m³")
        print()
    
    # Get token status
    print("=== Token Status ===")
    status = client.get_token_status()
    print(f"Has Token: {status['has_token']}")
    print(f"Token Expires: {status['token_expires']}")
    print(f"Remaining Days: {status['remaining_days']}")
    print(f"Auto Re-auth Enabled: {status['auto_reauth_enabled']}")
