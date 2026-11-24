# Myra AI Gemini - Deployment Guide

## Deployment Philosophy
**Reproducible, automated, and secure** - Every deployment should be consistent, traceable, and minimize downtime.

## Deployment Environments

### Environment Matrix
| Environment | Purpose | URL | Data | Scaling | Monitoring |
|------------|---------|-----|------|---------|------------|
| **Development** | Local development | `localhost:3000` | Ephemeral | Single instance | Basic logs |
| **Staging** | Pre-production testing | `staging.myra.ai` | Test data | Single instance | Full monitoring |
| **Production** | Live users | `app.myra.ai` | Real user data | Auto-scaling | Full monitoring + alerts |

## Prerequisites

### System Requirements
```yaml
# Minimum requirements
cpu: 2 cores
memory: 4 GB RAM
storage: 2 GB free space
os: Windows 10/11, macOS 11+, Linux (Ubuntu 20.04+)

# Recommended for production
cpu: 4+ cores
memory: 8+ GB RAM  
storage: 10+ GB free space
network: 10+ Mbps bandwidth
```

### Required Software
```bash
# Development
Node.js 18+ (LTS)
npm 8+ or yarn 1.22+
Git
VS Code (recommended)

# Production
Node.js 18+ (LTS)
PM2 or systemd (for process management)
nginx or Apache (reverse proxy)
Certbot (SSL certificates)
```

## Local Development Deployment

### Quick Start
```bash
# Clone repository
git clone https://github.com/your-org/myra-ai-gemini.git
cd myra-ai-gemini

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your settings

# Start development server
npm run dev
# Open http://localhost:3000
```

### Development with Hot Reload
```bash
# Frontend + Backend with hot reload
npm run dev

# Electron development
npm run electron:dev

# Watch mode for specific parts
npm run dev:frontend  # Vite dev server only
npm run dev:backend   # TypeScript watch mode
```

### Development Database Setup
```bash
# Initialize development data directory
mkdir -p .myra-data

# Reset development data
npm run dev:reset-data

# Seed with test data
npm run dev:seed-data
```

## Production Deployment

### Deployment Checklist
- [ ] Code is reviewed and merged to main
- [ ] All tests pass (`npm test`)
- [ ] Build passes (`npm run build`)
- [ ] Environment variables configured
- [ ] Database migrations applied (if any)
- [ ] SSL certificates configured
- [ ] Monitoring configured
- [ ] Backup strategy in place
- [ ] Rollback plan prepared

### Single Server Deployment

#### Step 1: Server Preparation
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 for process management
sudo npm install -g pm2

# Install nginx
sudo apt install -y nginx

# Install Certbot for SSL
sudo apt install -y certbot python3-certbot-nginx

# Create application user
sudo useradd -m -s /bin/bash myra
sudo passwd myra
```

#### Step 2: Application Setup
```bash
# Switch to application user
sudo su - myra

# Clone repository
git clone https://github.com/your-org/myra-ai-gemini.git
cd myra-ai-gemini

# Install dependencies
npm ci --only=production

# Set up environment
cp .env.example .env.production
# Edit .env.production with production values

# Build application
npm run build
```

#### Step 3: Process Management with PM2
```bash
# Create PM2 ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'myra-server',
    script: 'dist/server.cjs',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
}
EOF

# Start application with PM2
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save

# Set up PM2 startup script
pm2 startup systemd
# Follow the displayed instructions

# Enable PM2 logs rotation
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

#### Step 4: Nginx Configuration
```bash
# Create nginx site configuration
sudo tee /etc/nginx/sites-available/myra << 'EOF'
server {
    listen 80;
    server_name myra.yourdomain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    
    # Static file caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    
    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self' https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';" always;
}
EOF

# Enable site
sudo ln -s /etc/nginx/sites-available/myra /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### Step 5: SSL Configuration
```bash
# Obtain SSL certificate
sudo certbot --nginx -d myra.yourdomain.com

# Auto-renewal setup
sudo certbot renew --dry-run
```

#### Step 6: Data Directory Setup
```bash
# Create data directory
sudo mkdir -p /var/lib/myra-data
sudo chown -R myra:myra /var/lib/myra-data

# Set appropriate permissions
sudo chmod 750 /var/lib/myra-data

# Update environment to use this directory
echo "MYRA_DATA_DIR=/var/lib/myra-data" >> .env.production
```

### Docker Deployment

#### Dockerfile
```dockerfile
# Multi-stage build for smaller image
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build application
RUN npm run build

# Production image
FROM node:18-alpine

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache curl

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S myra -u 1001

# Create data directory
RUN mkdir -p /data && chown -R myra:nodejs /data

# Switch to non-root user
USER myra

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Start application
CMD ["node", "dist/server.cjs"]
```

#### Docker Compose
```yaml
version: '3.8'

services:
  myra:
    build: .
    container_name: myra-ai
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - MYRA_DATA_DIR=/data
      - GEMINI_API_KEY=${GEMINI_API_KEY}
    volumes:
      - myra-data:/data
      - ./logs:/app/logs
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    networks:
      - myra-network
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  myra-data:
    driver: local

networks:
  myra-network:
    driver: bridge
```

#### Deployment Commands
```bash
# Build and run
docker-compose build
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Update services
docker-compose pull
docker-compose up -d --build
```

### Kubernetes Deployment

#### Deployment Manifest
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myra-deployment
  labels:
    app: myra
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myra
  template:
    metadata:
      labels:
        app: myra
    spec:
      containers:
      - name: myra
        image: myregistry/myra-ai:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        - name: PORT
          value: "3000"
        - name: GEMINI_API_KEY
          valueFrom:
            secretKeyRef:
              name: myra-secrets
              key: gemini-api-key
        volumeMounts:
        - name: myra-data
          mountPath: /data
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: myra-data
        persistentVolumeClaim:
          claimName: myra-pvc
```

#### Service Manifest
```yaml
apiVersion: v1
kind: Service
metadata:
  name: myra-service
spec:
  selector:
    app: myra
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
```

#### Ingress Manifest
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myra-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
  - hosts:
    - myra.yourdomain.com
    secretName: myra-tls
  rules:
  - host: myra.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: myra-service
            port:
              number: 80
```

#### Persistent Volume Claim
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: myra-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

## Desktop Application Deployment

### Windows Deployment

#### NSIS Installer Configuration
```yaml
# electron-builder.yml
appId: com.myra.ai
productName: Myra AI
directories:
  output: release
  buildResources: build

files:
  - dist/**/*
  - node_modules/**/*
  - package.json

win:
  target: nsis
  icon: build/icon.ico

nsis:
  oneClick: false
  perMachine: true
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Myra AI
  installerIcon: build/installer.ico
  uninstallerIcon: build/uninstaller.ico
  license: LICENSE.txt

publish:
  provider: github
  releaseType: release
```

#### Build Commands
```bash
# Build for Windows
npm run electron:build:win

# Build with code signing (requires certificate)
npm run electron:build:win -- --win signingIdentity="Your Certificate"

# Create portable version
npm run electron:build:win -- --win portable
```

#### Code Signing
```bash
# Purchase code signing certificate
# Export to PFX format
# Configure environment variables
export WIN_CSC_LINK=path/to/certificate.pfx
export WIN_CSC_KEY_PASSWORD=your_password

# Build with signing
npm run electron:build:win
```

### macOS Deployment

#### Build Configuration
```yaml
mac:
  target: dmg
  category: public.app-category.developer-tools
  icon: build/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
```

#### Build Commands
```bash
# Build for macOS
npm run electron:build:mac

# Notarize for macOS
npm run electron:notarize

# Create DMG with custom background
npm run electron:build:mac -- --mac dmg
```

#### Notarization
```javascript
// notarize.js
const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  return await notarize({
    appBundleId: 'com.myra.ai',
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID
  })
}
```

### Linux Deployment

#### Build Configuration
```yaml
linux:
  target:
    - AppImage
    - deb
    - rpm
  category: Development
  icon: build/icon.png
  maintainer: support@myra.ai
  vendor: Myra AI
  desktop:
    Name: Myra AI
    Comment: AI Development Assistant
    Keywords: ai;development;assistant
    StartupWMClass: myra-ai
```

#### Build Commands
```bash
# Build AppImage
npm run electron:build:linux

# Build DEB package
npm run electron:build:linux -- --linux deb

# Build RPM package  
npm run electron:build:linux -- --linux rpm

# Build for ARM
npm run electron:build:linux -- --arm64
```

## Continuous Deployment

### GitHub Actions Workflow
```yaml
name: Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Run tests
      run: npm test
    
    - name: Build
      run: npm run build

  deploy-staging:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Deploy to Staging
      uses: appleboy/ssh-action@v0.1.5
      with:
        host: ${{ secrets.STAGING_HOST }}
        username: ${{ secrets.STAGING_USER }}
        key: ${{ secrets.STAGING_SSH_KEY }}
        script: |
          cd /opt/myra-staging
          git pull origin main
          npm ci --only=production
          npm run build
          pm2 restart myra-staging

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Deploy to Production
      uses: appleboy/ssh-action@v0.1.5
      with:
        host: ${{ secrets.PRODUCTION_HOST }}
        username: ${{ secrets.PRODUCTION_USER }}
        key: ${{ secrets.PRODUCTION_SSH_KEY }}
        script: |
          cd /opt/myra-production
          git pull origin main
          npm ci --only=production
          npm run build
          pm2 restart myra-production
          
    - name: Notify Slack
      uses: 8398a7/action-slack@v3
      with:
        status: ${{ job.status }}
        channel: '#deployments'
        username: Deployment Bot
```

### Environment Configuration

#### Environment Variables
```bash
# Required
NODE_ENV=production
PORT=3000
GEMINI_API_KEY=your_gemini_api_key
MYRA_DATA_DIR=/var/lib/myra-data

# Optional
MYRA_REMOTE=1
MYRA_REMOTE_PUBLIC_URL=https://myra.yourdomain.com
MYRA_TRUST_PROXY=1
MYRA_INTELLIGENCE=1
MYRA_INTELLIGENCE_MODEL=gemini-3.8-flash
LOG_LEVEL=info
```

#### Secrets Management
```bash
# Using environment files
echo "GEMINI_API_KEY=your_key" >> /etc/myra.env
chmod 600 /etc/myra.env

# Using Docker secrets
echo "your_key" | docker secret create gemini_api_key -

# Using Kubernetes secrets
kubectl create secret generic myra-secrets \
  --from-literal=gemini-api-key=your_key \
  --from-literal=other-secret=value
```

## Monitoring & Maintenance

### Health Checks
```bash
# Application health
curl http://localhost:3000/api/health

# Database health
curl http://localhost:3000/api/health/db

# External services health
curl http://localhost:3000/api/health/external

# Detailed health report
curl http://localhost:3000/api/health/detailed
```

### Log Management
```bash
# View application logs
pm2 logs myra-server

# View nginx logs
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log

# View system logs
journalctl -u myra-server -f
journalctl -u nginx -f

# Log rotation configuration
# /etc/logrotate.d/myra
/var/log/myra/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 640 myra myra
    postrotate
        pm2 reloadLogs
    endscript
}
```

### Backup Strategy

#### Data Backup
```bash
# Backup script
#!/bin/bash
BACKUP_DIR="/backup/myra"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/myra_data_$DATE.tar.gz"

# Create backup
tar -czf $BACKUP_FILE /var/lib/myra-data

# Upload to cloud storage
aws s3 cp $BACKUP_FILE s3://myra-backups/

# Clean up old backups (keep 30 days)
find $BACKUP_DIR -name "*.tar.gz" -mtime +30 -delete

# Daily cron job
0 2 * * * /opt/myra/scripts/backup.sh
```

#### Configuration Backup
```bash
# Backup configuration files
tar -czf /backup/myra_config_$(date +%Y%m%d).tar.gz \
  /etc/nginx/sites-available/myra \
  /opt/myra/.env.production \
  /opt/myra/ecosystem.config.js
```

### Scaling Strategies

#### Vertical Scaling
```bash
# Increase PM2 memory limit
pm2 reload myra-server --max-memory-restart 2G

# Increase Node.js heap size
NODE_OPTIONS="--max-old-space-size=4096" pm2 restart myra-server
```

#### Horizontal Scaling
```bash
# Increase PM2 instances
pm2 scale myra-server 4

# Load balancer configuration
upstream myra_backend {
    least_conn;
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;
    server 127.0.0.1:3002;
    server 127.0.0.1:3003;
}
```

## Disaster Recovery

### Recovery Procedures

#### Application Failure
```bash
# Restart application
pm2 restart myra-server

# Check logs for errors
pm2 logs myra-server --lines 100

# Restore from backup if needed
systemctl stop myra-server
tar -xzf /backup/myra_data_latest.tar.gz -C /var/lib/myra-data
systemctl start myra-server
```

#### Database Corruption
```bash
# Stop application
systemctl stop myra-server

# Restore latest backup
rm -rf /var/lib/myra-data/*
tar -xzf /backup/myra_data_latest.tar.gz -C /var/lib/myra-data

# Fix permissions
chown -R myra:myra /var/lib/myra-data
chmod -R 750 /var/lib/myra-data

# Start application
systemctl start myra-server
```

#### Server Failure
```bash
# Provision new server
# Follow deployment steps

# Restore data
scp backup-server:/backup/myra_data_latest.tar.gz .
tar -xzf myra_data_latest.tar.gz -C /var/lib/myra-data

# Update DNS
# Point domain to new server IP
```

### Rollback Procedures

#### Application Rollback
```bash
# Revert to previous Git commit
cd /opt/myra-production
git checkout HEAD~1

# Reinstall dependencies
npm ci --only=production

# Rebuild
npm run build

# Restart
pm2 restart myra-production

# Verify
curl http://localhost:3000/api/health
```

#### Configuration Rollback
```bash
# Restore previous configuration
cp /backup/myra_config_previous.tar.gz /tmp/
tar -xzf /tmp/myra_config_previous.tar.gz -C /

# Restart services
systemctl restart nginx
pm2 restart myra-server
```

## Security Hardening

### Server Security
```bash
# Firewall configuration
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# SSH hardening
sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# Automatic security updates
apt install unattended-upgrades
dpkg-reconfigure --priority=low unattended-upgrades
```

### Application Security
```bash
# Run as non-root user
sudo -u myra npm start

# File permissions
chmod 750 /opt/myra
chmod 640 /opt/myra/.env.production

# Regular security scans
npm audit
npm audit fix
```

## Performance Optimization

### Node.js Optimization
```bash
# Increase file descriptors
ulimit -n 8192

# Optimize garbage collection
NODE_OPTIONS="--max-old-space-size=4096 --optimize-for-size"

# Enable worker threads for CPU-intensive tasks
export UV_THREADPOOL_SIZE=$(nproc)
```

### Nginx Optimization
```nginx
# /etc/nginx/nginx.conf
worker_processes auto;
worker_rlimit_nofile 65535;

events {
    worker_connections 4096;
    multi_accept on;
    use epoll;
}

http {
    # Buffer optimizations
    client_body_buffer_size 10K;
    client_header_buffer_size 1k;
    client_max_body_size 8m;
    large_client_header_buffers 2 1k;
    
    # Timeouts
    client_body_timeout 12;
    client_header_timeout 12;
    keepalive_timeout 15;
    send_timeout 10;
    
    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 10240;
    gzip_proxied expired no-cache no-store private auth;
    gzip_types text/plain text/css text/xml text/javascript application/javascript application/xml+rss application/json;
    gzip_disable "MSIE [1-6]\.";
}
```

## Cost Optimization

### Resource Optimization
```bash
# Monitor resource usage
pm2 monit

# Right-size instances
# Based on monitoring data:
# - CPU usage < 60% average → reduce instance size
# - Memory usage > 80% → increase memory
# - Network usage < 10% → reduce bandwidth

# Auto-scaling rules
# Scale up when CPU > 70% for 5 minutes
# Scale down when CPU < 30% for 10 minutes
```

### CDN Configuration
```bash
# Configure CloudFront or similar CDN
# Cache static assets at edge
# Reduce origin server load
# Improve global performance
```

## Compliance & Auditing

### Access Logging
```nginx
# Enhanced access logging
log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                '$status $body_bytes_sent "$http_referer" '
                '"$http_user_agent" "$http_x_forwarded_for" '
                'rt=$request_time uct="$upstream_connect_time" '
                'uht="$upstream_header_time" urt="$upstream_response_time"';
```

### Audit Trail
```bash
# Install auditd
apt install auditd

# Configure audit rules
# Monitor sensitive files
auditctl -w /opt/myra/.env.production -p wa -k myra_config
auditctl -w /var/lib/myra-data -p wa -k myra_data

# Regular audit review
ausearch -k myra_config | aureport -f -i
```

## Support & Troubleshooting

### Common Issues

#### High Memory Usage
```bash
# Identify memory leak
node --inspect dist/server.cjs
# Use Chrome DevTools to profile memory

# Increase memory limit
NODE_OPTIONS="--max-old-space-size=4096"

# Monitor with PM2
pm2 monit
```

#### Slow Response Times
```bash
# Check database performance
# Analyze slow queries

# Check external API latency
curl -w "@curl-format.txt" https://generativelanguage.googleapis.com/

# Enable detailed logging
LOG_LEVEL=debug pm2 restart myra-server
```

#### Connection Issues
```bash
# Check firewall
ufw status

# Check port availability
netstat -tulpn | grep :3000

# Check DNS resolution
dig myra.yourdomain.com
```

### Debug Mode
```bash
# Enable debug logging
export LOG_LEVEL=debug
export NODE_ENV=development
npm start

# Or with PM2
pm2 start ecosystem.config.js --env development
```

## Update Procedures

### Minor Updates
```bash
# Pull latest changes
cd /opt/myra-production
git pull origin main

# Update dependencies
npm ci --only=production

# Rebuild
npm run build

# Restart
pm2 restart myra-production
```

### Major Updates
```bash
# Create backup
/opt/myra/scripts/backup.sh

# Update with maintenance mode
# 1. Put up maintenance page
# 2. Stop application
# 3. Apply updates
# 4. Test thoroughly
# 5. Restart application
# 6. Remove maintenance page

# Rollback if needed
git checkout previous-tag
npm ci --only=production
npm run build
pm2 restart myra-production
```

---

*Deployment Guide Version: 1.0*  
*Last Updated: 2026-11-24*  
*Based on: THE VIBE CODING BLUEPRINT - Deployment & Operations Section*