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
    password="your-password"
)

# List all devices
devices = client.list_devices()
print(f"Found {len(devices)} devices")

# Get IAQ health score
health = client.get_iaq_health_score(device_id="...")
print(f"Health Score: {health['health_score']}/100 (Grade {health['grade']})")
```

### Node.js
```javascript
const { KukiOSClient } = require('kukios-mcp-client');

// Initialize client
const client = new KukiOSClient({
    url: 'https://dashbeta.what-if.sg',
    email: 'user@email.com',
    password: 'your-password'
});

// List all devices
const devices = await client.listDevices();
console.log(`Found ${devices.length} devices`);

// Get IAQ health score
const health = await client.getIAQHealthScore(deviceId);
console.log(`Health Score: ${health.health_score}/100 (Grade ${health.grade})`);
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
- `batch_get_devices(device_ids)` - Get multiple devices (concurrent fan-out)

### Readings
- `get_latest_readings(device_id)` - Get latest sensor data
- `get_historical_readings(device_id, days=30)` - Get historical data (backend takes a `days` window)
- `get_device_readings(device_id, start, end, limit, aggregate)` - Readings over a time window
- `batch_get_latest_readings(device_ids)` - Readings for multiple devices (concurrent fan-out)

### IAQ Analysis (computed client-side, mirrors kukios-mcp-server)
- `analyze_iaq_quality(device_id, standard_code="GOAQS")` - Analyze with issues + prioritized actions
- `get_iaq_recommendations(building_id=None)` - Prioritized actions across devices
- `get_iaq_health_score(device_id)` - Health score 0-100 with grade + parameter breakdown
- `compare_to_standards(device_id, standard="SS554")` - Compare latest readings against standard thresholds

### Compliance
- `list_standards()` - List compliance standards
- `calculate_compliance(device_id, standard_id, start_time, end_time)` - Server-side calculation over a window

### Reports
- `list_reports(page=1, page_size=100)` - List reports
- `generate_report_pdf(report_id)` - Generate PDF for an existing report

### Operations
- `health_check()` - Platform health (GET /health)
- `get_realtime_status()` - Real-time system status
- `get_sensor_history(device_id, hours=24)` - Sensor history

### Alerts
- `list_alerts(status, severity, device_id, building_id, standard_code, page=1, page_size=50)` - List IAQ alerts
- `acknowledge_alert(alert_id, notes="")` - Acknowledge alert
- `resolve_alert(alert_id, resolution="")` - Resolve alert
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

`IAQ_*` variables match the kukios-mcp-server convention; `KUKIOS_*` aliases are kept for compatibility.
```bash
export IAQ_REPORTER_URL="https://dashbeta.what-if.sg"   # or KUKIOS_URL
export IAQ_EMAIL="user@email.com"                       # or KUKIOS_EMAIL
export IAQ_PASSWORD="your-password"                     # or KUKIOS_PASSWORD
# Optional pre-authenticated tokens (skip login):
export IAQ_TOKEN="..."
export IAQ_REFRESH_TOKEN="..."
```

### Advanced Options
```python
client = KukiOSClient(
    url="https://dashbeta.what-if.sg",
    email="user@email.com",
    password="your-password",
    timeout=30,      # Request timeout in seconds
    max_retries=3,   # Maximum retry attempts
    retry_delay=1,   # Initial retry delay in seconds
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

**Note:** KūkiOS MCP server is cloud-hosted. All connections go to `https://dashbeta.what-if.sg`. No local MCP server required.

## Support

- 📧 Email: kuki@what-if.sg
- 🌐 Website: https://what-if.sg

## License

MIT © What If Labs
