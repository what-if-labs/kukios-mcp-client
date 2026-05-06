# KūkiOS MCP Client

Official client library for connecting to KūkiOS IAQ Monitoring Platform via MCP (Model Context Protocol).

## Features

- ✅ **Auto Authentication** - Automatic token management and refresh
- ✅ **Python + Node.js** - Cross-language support
- ✅ **Simple API** - Easy-to-use methods for all MCP tools
- ✅ **Error Handling** - Graceful error handling and retries
- ✅ **Type Hints** - Full type annotations for Python
- ✅ **Promise-based** - Modern async/await for Node.js

## Installation

### Python
```bash
pip install kukios-mcp-client
```

### Node.js
```bash
npm install kukios-mcp-client
```

## Quick Start

### Python
```python
from kukios_mcp_client import KukiOSClient

# Initialize client
client = KukiOSClient(
    url="https://dashbeta.what-if.sg",
    email="user@email.com",
    password="password"
)

# List all devices
devices = client.list_devices()
print(f"Found {len(devices)} devices")

# Get IAQ health score
health = client.get_iaq_health_score(device_id="...")
print(f"Health Score: {health['health_score']}/100 (Grade {health['grade']})")

# Get latest readings
readings = client.get_latest_readings(device_id="...")
print(f"Temperature: {readings['readings'][0]['temperature']}°C")
```

### Node.js
```javascript
const { KukiOSClient } = require('kukios-mcp-client');

// Initialize client
const client = new KukiOSClient({
    url: 'https://dashbeta.what-if.sg',
    email: 'user@email.com',
    password: 'password'
});

// List all devices
const devices = await client.listDevices();
console.log(`Found ${devices.length} devices`);

// Get IAQ health score
const health = await client.getIAQHealthScore(deviceId);
console.log(`Health Score: ${health.health_score}/100 (Grade ${health.grade})`);

// Get latest readings
const readings = await client.getLatestReadings(deviceId);
console.log(`Temperature: ${readings.readings[0].temperature}°C`);
```

## API Reference

### Authentication
- `auth_login(email, password)` - Login and store credentials
- `auth_refresh(refresh_token)` - Refresh JWT token
- `get_current_user()` - Get current user info
- `get_token_status()` - Check token expiry and status

### Buildings
- `list_buildings(page, page_size)` - List all buildings
- `get_building(building_id)` - Get building details

### Devices
- `list_devices()` - List all devices
- `get_device(device_id)` - Get device details
- `create_device(name, building_id, ...)` - Create new device
- `update_device_position(device_id, x, y)` - Update floorplan position
- `delete_device(device_id)` - Delete device
- `batch_get_devices(device_ids)` - Get multiple devices

### Readings
- `get_latest_readings(device_id)` - Get latest sensor data
- `get_historical_readings(device_id, start, end)` - Get historical data
- `batch_get_latest_readings(device_ids)` - Get readings for multiple devices

### IAQ Analysis
- `analyze_iaq_quality(device_id)` - Analyze with recommendations
- `get_iaq_recommendations(device_id)` - Get prioritized actions
- `get_iaq_health_score(device_id)` - Get health score (0-100)
- `compare_to_standards(device_id, standard)` - Compare against standards

### Compliance
- `list_standards()` - List compliance standards
- `calculate_compliance(device_id, standard)` - Calculate compliance grade

### Reports
- `list_reports()` - List reports
- `generate_report_pdf(building_id)` - Generate PDF report

### Alerts
- `list_alerts(status, severity, device_id)` - List IAQ alerts
- `acknowledge_alert(alert_id)` - Acknowledge alert
- `resolve_alert(alert_id)` - Resolve alert

## Auto Re-Authentication

The client automatically handles token expiry and refresh:

1. **Token Expiry Check** - Before each request, checks if token expires within 24 hours
2. **Auto Refresh** - Uses refresh token to get new access token
3. **Full Re-Auth** - If refresh fails, re-authenticates with stored credentials
4. **Retry** - Retries failed requests with new token

All transparent to the user!

## Error Handling

### Python
```python
try:
    devices = client.list_devices()
except KukiOSAuthError as e:
    print(f"Authentication failed: {e}")
except KukiOSAPIError as e:
    print(f"API error: {e}")
except KukiOSConnectionError as e:
    print(f"Connection failed: {e}")
```

### Node.js
```javascript
try {
    const devices = await client.listDevices();
} catch (error) {
    if (error instanceof KukiOSAuthError) {
        console.error(`Authentication failed: ${error.message}`);
    } else if (error instanceof KukiOSAPIError) {
        console.error(`API error: ${error.message}`);
    } else if (error instanceof KukiOSConnectionError) {
        console.error(`Connection failed: ${error.message}`);
    }
}
```

## Configuration

### Environment Variables
```bash
# Python
export KUKIOS_URL="https://dashbeta.what-if.sg"
export KUKIOS_EMAIL="user@email.com"
export KUKIOS_PASSWORD="password"

# Node.js
export KUKIOS_URL="https://dashbeta.what-if.sg"
export KUKIOS_EMAIL="user@email.com"
export KUKIOS_PASSWORD="password"
```

### Advanced Options
```python
client = KukiOSClient(
    url="https://dashbeta.what-if.sg",
    email="user@email.com",
    password="password",
    timeout=30,  # Request timeout in seconds
    max_retries=3,  # Maximum retry attempts
    retry_delay=1,  # Initial retry delay in seconds
    cache_ttl=300  # Cache TTL in seconds
)
```

## MCP Integration

### Claude Desktop
```json
{
  "mcpServers": {
    "kukios": {
      "url": "https://dashbeta.what-if.sg",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

### mcporter
```bash
mcporter config add kukios \
  --url https://dashbeta.what-if.sg \
  --header "Authorization: Bearer YOUR_TOKEN"
```

## Support

- 📧 Email: hello@what-if.sg
- 🌐 Website: https://what-if.sg
- 📚 Documentation: https://docs.what-if.sg

## License

MIT © What If Labs
