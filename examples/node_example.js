#!/usr/bin/env node
/**
 * KūkiOS MCP Client - Node.js Example
 */

const { KukiOSClient } = require('../node/src/KukiOSClient');

async function main() {
    // Initialize client
    const client = new KukiOSClient({
        url: 'https://dashbeta.what-if.sg',
        email: 'your@email.com',
        password: 'your-password'
    });
    
    // List all devices
    console.log('=== Listing Devices ===');
    const devices = await client.listDevices();
    console.log(`Found ${devices.length} devices\n`);
    
    for (const device of devices) {
        console.log(`Device: ${device.name}`);
        console.log(`  ID: ${device.id}`);
        console.log(`  Building: ${device.building_id}`);
        console.log();
    }
    
    // Get IAQ health score for first device
    if (devices.length > 0) {
        const deviceId = devices[0].id;
        console.log(`=== IAQ Health Score for ${devices[0].name} ===`);
        const health = await client.getIAQHealthScore(deviceId);
        console.log(`Score: ${health.health_score}/100`);
        console.log(`Grade: ${health.grade}`);
        console.log(`Message: ${health.message}`);
        console.log();
        
        // Get latest readings
        console.log('=== Latest Readings ===');
        const readings = await client.getLatestReadings(deviceId);
        if (readings.readings && readings.readings.length > 0) {
            const latest = readings.readings[0];
            console.log(`Temperature: ${latest.temperature}°C`);
            console.log(`Humidity: ${latest.humidity}%`);
            console.log(`PM2.5: ${latest.pm25} µg/m³`);
            console.log(`CO2: ${latest.co2} ppm`);
            console.log(`TVOC: ${latest.tvoc} µg/m³`);
            console.log();
        }
        
        // Get token status
        console.log('=== Token Status ===');
        const status = await client.getTokenStatus();
        console.log(`Has Token: ${status.hasToken}`);
        console.log(`Token Expires: ${status.tokenExpires}`);
        console.log(`Remaining Days: ${status.remainingDays}`);
        console.log(`Auto Re-auth Enabled: ${status.autoReauthEnabled}`);
    }
}

main().catch(console.error);
