# Network Troubleshooting Runbook

## Purpose
Diagnose and resolve network-related issues affecting Myra AI Gemini connectivity and performance.

## Network Architecture Overview

### Myra AI Gemini Network Components
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Desktop App   │    │   Local Server  │    │   Phone Remote  │
│   (Electron)    │◄──►│   (127.0.0.1)   │◄──►│   (Browser)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  System APIs    │    │   WebSocket     │    │   External APIs │
│  (File, Browser)│    │   (Audio/Voice) │    │   (Gemini AI)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Default Port Configuration
| Service | Port | Protocol | Purpose | Default Binding |
|---------|------|----------|---------|-----------------|
| HTTP Server | 3000 | TCP | API & Dashboard | 127.0.0.1 |
| WebSocket | 3000 | TCP | Real-time audio | 127.0.0.1 |
| Tailscale Serve | Random | TCP | Remote access | 0.0.0.0 (via Tailscale) |
| Health Check | 3000 | TCP | Monitoring | 127.0.0.1 |

## Common Network Issues

### Issue 1: Port 3000 Already In Use
**Symptoms**: 
- "Port 3000 is already in use" error
- Server fails to start
- Multiple Myra instances attempting to run

**Diagnostic Steps**:
```bash
# 1. Check what's using port 3000
netstat -tulpn | grep :3000
# Windows: netstat -ano | findstr :3000
# macOS: lsof -i :3000

# 2. Identify the process
# Linux/macOS: ps aux | grep <PID>
# Windows: tasklist | findstr <PID>

# 3. Check for zombie Myra processes
ps aux | grep -E "(node|myra)" | grep -v grep

# 4. Check PM2 status (if using PM2)
pm2 list
pm2 logs
```

**Resolution Steps**:
```bash
# Option A: Kill existing process
kill -9 $(lsof -t -i:3000)

# Option B: Change Myra port
# Edit .env file:
echo "PORT=3001" >> .env.production
# Update Electron app to connect to new port

# Option C: Use different port at startup
npm start -- --port 3001

# Option D: Clean PM2 processes
pm2 delete all
pm2 flush
pm2 start ecosystem.config.js
```

**Prevention**:
```bash
# Add port check on startup
#!/bin/bash
PORT=3000
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
  echo "Port $PORT is in use, trying $((PORT+1))"
  export PORT=$((PORT+1))
fi

# Use dynamic port allocation
PORT=${PORT:-$(python3 -c "import socket; s=socket.socket(); s.bind(('', 0)); print(s.getsockname()[1]); s.close()")}
```

### Issue 2: WebSocket Connection Failures
**Symptoms**:
- "WebSocket connection failed"
- Audio streaming not working
- Real-time features broken
- Intermittent disconnections

**Diagnostic Steps**:
```bash
# 1. Test WebSocket connectivity
websocat ws://127.0.0.1:3000/ws
# Or using wscat: npx wscat -c ws://127.0.0.1:3000/ws

# 2. Check WebSocket handshake
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  -H "Sec-WebSocket-Version: 13" \
  http://127.0.0.1:3000/ws

# 3. Monitor WebSocket traffic
tcpdump -i lo -A -s 0 'port 3000 and (tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x47455420)'

# 4. Check application logs
grep -E "(WebSocket|ws:|/ws)" /var/log/myra/server.log | tail -20
```

**Resolution Steps**:
```bash
# 1. Increase WebSocket limits
# In server configuration:
export WS_MAX_PAYLOAD=1048576  # 1MB
export WS_HEARTBEAT_INTERVAL=25000  # 25 seconds
export WS_MAX_CONNECTIONS=1000

# 2. Configure proper WebSocket headers
# In Express middleware:
app.use('/ws', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
});

# 3. Implement reconnection logic
# Client-side:
class WebSocketManager {
  constructor(url) {
    this.url = url;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.connect();
  }
  
  connect() {
    this.ws = new WebSocket(this.url);
    
    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    };
    
    this.ws.onclose = () => {
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        setTimeout(() => {
          this.reconnectAttempts++;
          this.connect();
        }, this.reconnectDelay * Math.pow(2, this.reconnectAttempts));
      }
    };
  }
}

# 4. Check firewall settings
sudo ufw allow 3000/tcp
sudo ufw reload
```

### Issue 3: Slow Network Performance
**Symptoms**:
- High latency in voice responses
- Audio choppiness or dropouts
- Slow file transfers
- Timeout errors

**Diagnostic Steps**:
```bash
# 1. Measure network latency
ping -c 10 127.0.0.1
# Localhost should be < 1ms

# 2. Check for packet loss
mtr 127.0.0.1
# Run for 60 seconds to identify intermittent issues

# 3. Measure bandwidth
# Install iperf3: sudo apt install iperf3
# Server: iperf3 -s
# Client: iperf3 -c 127.0.0.1

# 4. Check system network stats
netstat -s
# Look for retransmits, errors, resets

# 5. Monitor real-time traffic
iftop -i lo
# Monitor localhost traffic
```

**Resolution Steps**:
```bash
# 1. Optimize TCP settings
# /etc/sysctl.conf
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.ipv4.tcp_congestion_control = bbr

# Apply: sudo sysctl -p

# 2. Adjust WebSocket chunk size
# For high latency: increase chunk size
export AUDIO_CHUNK_SIZE=200  # 200ms instead of 100ms

# For high packet loss: decrease chunk size
export AUDIO_CHUNK_SIZE=50   # 50ms for more frequent transmission

# 3. Implement compression
# WebSocket compression:
const WebSocket = require('ws');
const wss = new WebSocket.Server({
  port: 3000,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    clientMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024
  }
});

# 4. Implement Quality of Service (QoS)
# Prioritize audio traffic
sudo tc qdisc add dev lo root handle 1: prio
sudo tc filter add dev lo protocol ip parent 1:0 prio 1 u32 match ip dport 3000 0xffff flowid 1:1
sudo tc filter add dev lo protocol ip parent 1:0 prio 2 u32 match ip sport 3000 0xffff flowid 1:1
```

### Issue 4: DNS Resolution Problems
**Symptoms**:
- "Cannot resolve hostname" errors
- External API calls failing
- Intermittent connectivity to Gemini API
- Slow initial connections

**Diagnostic Steps**:
```bash
# 1. Test DNS resolution
dig generativelanguage.googleapis.com
nslookup generativelanguage.googleapis.com

# 2. Check DNS response times
time dig generativelanguage.googleapis.com

# 3. Test with different DNS servers
dig @8.8.8.8 generativelanguage.googleapis.com
dig @1.1.1.1 generativelanguage.googleapis.com

# 4. Check /etc/resolv.conf
cat /etc/resolv.conf

# 5. Test connectivity to DNS servers
ping -c 3 8.8.8.8
ping -c 3 1.1.1.1
```

**Resolution Steps**:
```bash
# 1. Configure reliable DNS servers
# /etc/resolv.conf
nameserver 8.8.8.8
nameserver 1.1.1.1
nameserver 9.9.9.9

# 2. Implement DNS caching
# Install and configure dnsmasq or nscd
sudo apt install dnsmasq
sudo systemctl enable dnsmasq
sudo systemctl start dnsmasq

# 3. Add DNS fallback in application
const dns = require('dns');
const hosts = ['generativelanguage.googleapis.com'];
const dnsServers = ['8.8.8.8', '1.1.1.1', '9.9.9.9'];

async function resolveWithFallback(hostname) {
  for (const server of dnsServers) {
    try {
      dns.setServers([server]);
      const addresses = await dns.promises.resolve4(hostname);
      return addresses[0];
    } catch (error) {
      console.warn(`DNS server ${server} failed for ${hostname}`);
    }
  }
  throw new Error(`All DNS servers failed for ${hostname}`);
}

# 4. Implement connection pooling
# Reuse TCP connections to avoid DNS lookups
const https = require('https');
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 1000
});
```

### Issue 5: Firewall/Proxy Interference
**Symptoms**:
- Connections blocked
- SSL/TLS handshake failures
- Inconsistent connectivity
- Specific ports not working

**Diagnostic Steps**:
```bash
# 1. Check firewall status
sudo ufw status verbose
sudo iptables -L -n -v

# 2. Test port accessibility
nc -zv 127.0.0.1 3000
# From remote: nc -zv your-server-ip 3000

# 3. Check proxy settings
echo $http_proxy
echo $https_proxy
echo $no_proxy

# 4. Test SSL/TLS connectivity
openssl s_client -connect generativelanguage.googleapis.com:443
# Check certificate chain and cipher negotiation

# 5. Trace route to identify blocking points
traceroute generativelanguage.googleapis.com
# Windows: tracert generativelanguage.googleapis.com
```

**Resolution Steps**:
```bash
# 1. Configure firewall rules
sudo ufw allow 3000/tcp comment 'Myra AI Gemini'
sudo ufw allow from 192.168.1.0/24 to any port 3000 comment 'Local network'
sudo ufw reload

# 2. Configure application for proxy
# Set proxy environment variables
export http_proxy=http://proxy.example.com:8080
export https_proxy=http://proxy.example.com:8080
export no_proxy=localhost,127.0.0.1

# Or configure in Node.js
const HttpsProxyAgent = require('https-proxy-agent');
const proxyAgent = new HttpsProxyAgent('http://proxy.example.com:8080');

# 3. Implement proxy auto-detection
try {
  // Try direct connection first
  await makeRequest();
} catch (directError) {
  // If direct fails, try with proxy
  const proxy = detectProxy();
  if (proxy) {
    await makeRequestWithProxy(proxy);
  } else {
    throw directError;
  }
}

# 4. Configure SSL/TLS settings
# For corporate proxies that inspect SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';  # WARNING: Only for testing!
# Better: Add corporate CA to trust store
```

## Remote Access Issues

### Issue 6: Tailscale Serve Problems
**Symptoms**:
- Phone remote not connecting
- "Cannot reach desktop" error
- Tailscale connection issues
- Intermittent remote access

**Diagnostic Steps**:
```bash
# 1. Check Tailscale status
tailscale status
tailscale netcheck

# 2. Check Tailscale Serve configuration
tailscale serve status
tailscale serve list

# 3. Test Tailscale connectivity
ping $(tailscale ip -4)
tailscale ping $(tailscale ip -4)

# 4. Check firewall rules for Tailscale
sudo ufw allow 41641/udp  # Tailscale port
sudo iptables -L | grep tailscale

# 5. Verify Serve is running
curl -f http://$(tailscale ip -4):3000/api/health
```

**Resolution Steps**:
```bash
# 1. Restart Tailscale Serve
tailscale serve reset
tailscale serve --bg 3000

# 2. Reauthenticate Tailscale if needed
tailscale logout
tailscale up

# 3. Configure persistent Serve
# Create systemd service for Tailscale Serve
cat > /etc/systemd/system/tailscale-serve.service << EOF
[Unit]
Description=Tailscale Serve for Myra AI
After=tailscale.service
Requires=tailscale.service

[Service]
Type=exec
ExecStart=/usr/bin/tailscale serve --bg 3000
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable tailscale-serve
sudo systemctl start tailscale-serve

# 4. Alternative: Use ngrok or localtunnel
npm install -g localtunnel
lt --port 3000 --subdomain myra-ai
```

### Issue 7: CORS/Cross-Origin Issues
**Symptoms**:
- "Cross-Origin Request Blocked" errors
- API calls failing from browser
- Preflight request failures
- Mixed content warnings

**Diagnostic Steps**:
```bash
# 1. Check CORS headers in responses
curl -I http://127.0.0.1:3000/api/health
# Look for: Access-Control-Allow-Origin

# 2. Test preflight requests
curl -X OPTIONS http://127.0.0.1:3000/api/intelligence/projects \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization"

# 3. Check browser console for CORS errors
# Open browser developer tools → Console tab

# 4. Verify SSL certificates for HTTPS
# Mixed content issues often arise from HTTP/HTTPS mismatches
```

**Resolution Steps**:
```bash
# 1. Configure CORS middleware properly
const cors = require('cors');

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://myra.yourdomain.com',
    // Add phone remote URLs
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept'
  ],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400  // 24 hours
}));

# 2. Handle preflight requests
app.options('*', cors());  // Enable preflight for all routes

# 3. Configure WebSocket CORS
const wss = new WebSocket.Server({
  port: 3000,
  verifyClient: (info, callback) => {
    const origin = info.origin;
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    ];
    
    if (allowedOrigins.includes(origin)) {
      callback(true);
    } else {
      callback(false, 401, 'Unauthorized origin');
    }
  }
});

# 4. Set proper headers for API responses
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});
```

## Performance Optimization

### Network Performance Tuning
```bash
#!/bin/bash
# network-optimization.sh

echo "=== Network Optimization for Myra AI ==="

# 1. Increase file descriptors
echo "fs.file-max = 2097152" >> /etc/sysctl.conf
echo "myra soft nofile 65536" >> /etc/security/limits.conf
echo "myra hard nofile 65536" >> /etc/security/limits.conf

# 2. Optimize TCP settings
cat >> /etc/sysctl.conf << EOF
# TCP optimization
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.core.netdev_max_backlog = 300000
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15
EOF

# 3. Apply changes
sysctl -p

# 4. Configure network interface (if not localhost)
# For physical interfaces:
# ethtool -K eth0 tso on gso on gro on
# ethtool -C eth0 rx-usecs 30 tx-usecs 30

# 5. Set up traffic shaping for audio priority
tc qdisc add dev lo root handle 1: prio bands 3
tc filter add dev lo protocol ip parent 1:0 prio 1 u32 match ip dport 3000 0xffff flowid 1:1
tc filter add dev lo protocol ip parent 1:0 prio 1 u32 match ip sport 3000 0xffff flowid 1:1
tc qdisc add dev lo parent 1:1 handle 10: sfq
tc qdisc add dev lo parent 1:2 handle 20: sfq
tc qdisc add dev lo parent 1:3 handle 30: sfq

echo "=== Network Optimization Complete ==="
```

### WebSocket Performance Optimization
```javascript
// WebSocket performance configuration
const WebSocket = require('ws');

const wss = new WebSocket.Server({
  port: 3000,
  maxPayload: 1048576, // 1MB max message size
  clientTracking: true,
  
  // Compression
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    clientMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024
  }
});

// Connection management
const connectionManager = {
  connections: new Map(),
  
  addConnection(ws, req) {
    const connectionId = Date.now() + Math.random().toString(36).substr(2, 9);
    this.connections.set(connectionId, {
      ws,
      ip: req.socket.remoteAddress,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      stats: {
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0
      }
    });
    
    return connectionId;
  },
  
  removeConnection(connectionId) {
    this.connections.delete(connectionId);
  },
  
  // Heartbeat to keep connections alive
  startHeartbeat() {
    setInterval(() => {
      for (const [id, connection] of this.connections) {
        if (Date.now() - connection.lastActivity > 30000) { // 30 seconds
          connection.ws.ping();
        }
        
        // Close stale connections
        if (Date.now() - connection.lastActivity > 120000) { // 2 minutes
          connection.ws.close();
          this.removeConnection(id);
        }
      }
    }, 10000); // Check every 10 seconds
  }
};

// Message batching for efficiency
class MessageBatcher {
  constructor(batchSize = 10, batchTimeout = 50) {
    this.batchSize = batchSize;
    this.batchTimeout = batchTimeout;
    this.batch = [];
    this.timer = null;
  }
  
  add(message) {
    this.batch.push(message);
    
    if (this.batch.length >= this.batchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.batchTimeout);
    }
  }
  
  flush() {
    if (this.batch.length > 0) {
      const batchMessage = {
        type: 'batch',
        messages: this.batch,
        timestamp: Date.now()
      };
      
      // Send batched message
      this.sendCallback(JSON.stringify(batchMessage));
      this.batch = [];
    }
    
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  
  setSendCallback(callback) {
    this.sendCallback = callback;
  }
}
```

## Monitoring & Diagnostics

### Network Monitoring Script
```bash
#!/bin/bash
# network-monitor.sh

LOG_FILE="/var/log/myra/network-monitor.log"
ALERT_THRESHOLD=80  # Percentage

echo "=== Network Monitoring $(date) ===" >> $LOG_FILE

# 1. Check port availability
if ! nc -z 127.0.0.1 3000 > /dev/null 2>&1; then
  echo "ALERT: Port 3000 not responding" >> $LOG_FILE
fi

# 2. Check WebSocket connectivity
WS_RESPONSE=$(timeout 5 websocat -t ws://127.0.0.1:3000/ws echo: 2>&1)
if [ $? -ne 0 ]; then
  echo "ALERT: WebSocket connection failed: $WS_RESPONSE" >> $LOG_FILE
fi

# 3. Monitor connection count
CONNECTION_COUNT=$(netstat -an | grep :3000 | grep ESTABLISHED | wc -l)
echo "Active connections: $CONNECTION_COUNT" >> $LOG_FILE

if [ $CONNECTION_COUNT -gt 100 ]; then
  echo "WARNING: High connection count: $CONNECTION_COUNT" >> $LOG_FILE
fi

# 4. Check network stats
RETRANSMITS=$(netstat -s | grep "segments retransmitted" | awk '{print $1}')
echo "TCP retransmits: $RETRANSMITS" >> $LOG_FILE

# 5. Monitor bandwidth usage (if not localhost)
# ifconfig eth0 | grep "RX bytes\|TX bytes"

# 6. Check DNS resolution time
DNS_TIME=$(time dig generativelanguage.googleapis.com > /dev/null 2>&1)
echo "DNS resolution time: $DNS_TIME" >> $LOG_FILE

# 7. Check Tailscale status
if command -v tailscale &> /dev/null; then
  TAILSCALE_STATUS=$(tailscale status 2>&1)
  if echo "$TAILSCALE_STATUS" | grep -q "stopped\|error"; then
    echo "ALERT: Tailscale issues: $TAILSCALE_STATUS" >> $LOG_FILE
  fi
fi

echo "=== Monitoring Complete ===" >> $LOG_FILE
```

### Automated Network Testing
```bash
#!/bin/bash
# network-test-suite.sh

echo "=== Myra AI Network Test Suite ==="
echo "Timestamp: $(date)"
echo ""

# Test 1: Local server accessibility
echo "1. Testing local server..."
if curl -f http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
  echo "  ✓ Local server responding"
else
  echo "  ✗ Local server not responding"
fi

# Test 2: WebSocket connectivity
echo "2. Testing WebSocket..."
if timeout 5 websocat -t ws://127.0.0.1:3000/ws echo: > /dev/null 2>&1; then
  echo "  ✓ WebSocket connection successful"
else
  echo "  ✗ WebSocket connection failed"
fi

# Test 3: External API connectivity
echo "3. Testing external API connectivity..."
if curl -f https://generativelanguage.googleapis.com/v1/models > /dev/null 2>&1; then
  echo "  ✓ Gemini API reachable"
else
  echo "  ✗ Gemini API unreachable"
fi

# Test 4: DNS resolution
echo "4. Testing DNS resolution..."
DNS_TIME=$(time (dig generativelanguage.googleapis.com > /dev/null 2>&1) 2>&1 | grep real | awk '{print $2}')
echo "  DNS resolution time: $DNS_TIME"

# Test 5: Port availability
echo "5. Checking port availability..."
OPEN_PORTS=$(netstat -tulpn | grep :3000 | wc -l)
echo "  Port 3000 connections: $OPEN_PORTS"

# Test 6: Network latency
echo "6. Measuring network latency..."
PING_RESULT=$(ping -c 3 127.0.0.1 | tail -1 | awk -F '/' '{print $5}')
echo "  Average latency: ${PING_RESULT}ms"

# Test 7: Bandwidth (if not localhost)
echo "7. Estimating bandwidth..."
# This test requires iperf3 server running
# iperf3 -c 127.0.0.1 -t 2 -J | jq '.end.sum_received.bits_per_second'

echo ""
echo "=== Test Suite Complete ==="
```

## Emergency Procedures

### Complete Network Failure
```bash
#!/bin/bash
# emergency-network-reset.sh

echo "=== EMERGENCY NETWORK RESET ==="
echo "This will reset all network configurations for Myra AI"
echo ""

read -p "Are you sure? This may disconnect all users. (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

# 1. Stop all services
echo "Stopping services..."
systemctl stop myra-server
systemctl stop nginx
systemctl stop tailscale 2>/dev/null || true

# 2. Reset firewall rules
echo "Resetting firewall..."
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
iptables -P INPUT ACCEPT
iptables -P FORWARD ACCEPT
iptables -P OUTPUT ACCEPT

# 3. Clear network configurations
echo "Clearing network configurations..."
ip route flush cache
sysctl -w net.ipv4.tcp_max_syn_backlog=1024
sysctl -w net.core.somaxconn=128

# 4. Kill all network connections to port 3000
echo "Closing connections..."
fuser -k 3000/tcp

# 5. Clear DNS cache
echo "Clearing DNS cache..."
systemctl restart systemd-resolved 2>/dev/null || true
nscd -i hosts 2>/dev/null || true

# 6. Start with basic configuration
echo "Starting with basic configuration..."
# Allow only essential ports
iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -P INPUT DROP

# 7. Restart services
echo "Restarting services..."
systemctl start myra-server
systemctl start nginx

# 8. Verify
echo "Verifying connectivity..."
sleep 5
if curl -f http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
  echo "✓ Basic connectivity restored"
else
  echo "✗ Connectivity still failing"
  exit 1
fi

echo ""
echo "=== Emergency Reset Complete ==="
echo "Basic network functionality restored."
echo "Review and reconfigure additional network settings as needed."
```

---

*Network Troubleshooting Runbook v1.0*
*Last Updated: 2026-11-24*
*Based on Runbooks Prompt Framework*