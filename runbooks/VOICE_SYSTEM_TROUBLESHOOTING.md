# Voice System Troubleshooting Runbook

## Purpose
Diagnose and resolve voice system issues in Myra AI Gemini.

## Quick Reference

### Common Symptoms
- ❌ "Voice not working"
- ❌ "Myra can't hear me"
- ❌ "No response from Myra"
- ❌ "Audio keeps cutting out"
- ❌ "Voice recognition poor"

### Quick Fixes (5-minute)
1. Check microphone permissions
2. Restart Myra application
3. Check internet connection
4. Verify Gemini API key
5. Test with sample audio

## Diagnostic Flowchart

```
User Reports Voice Issue
        ↓
[Check Microphone Access] → No → Grant Permissions
        ↓ Yes
[Check Myra Status] → Not Running → Start Myra
        ↓ Running
[Check Internet] → No Internet → Fix Connection
        ↓ Connected
[Check API Key] → Invalid/Missing → Update API Key
        ↓ Valid
[Test Basic Audio] → Fails → Hardware Issue
        ↓ Works
[Test Voice Recognition] → Fails → Model/Network Issue
        ↓ Works
[Check Specific Feature] → Issue → Feature-specific Fix
```

## Step-by-Step Procedures

### Procedure 1: Microphone Access Issues

**Symptoms**: 
- "Microphone permission denied"
- No audio input detected
- Can't start voice conversation

**Diagnostic Steps**:
1. Check browser/OS microphone permissions
2. Verify microphone is not muted
3. Test microphone with other apps
4. Check physical connections

**Resolution Steps**:
```bash
# Windows
# 1. Open Sound Settings
# 2. Check microphone privacy settings
# 3. Ensure Myra has microphone access

# macOS
# 1. System Preferences > Security & Privacy > Privacy
# 2. Check microphone permissions
# 3. Grant access to Myra

# Linux
# 1. Check PulseAudio permissions
# 2. Verify user is in audio group
# 3. Check ~/.config/pulse/default.pa
```

**Verification**:
```javascript
// Test microphone in browser console
navigator.mediaDevices.getUserMedia({ audio: true })
  .then(stream => console.log('Microphone access granted'))
  .catch(err => console.error('Microphone error:', err));
```

### Procedure 2: No Voice Response

**Symptoms**:
- Myra listens but doesn't respond
- No audio output
- "Processing" state stuck

**Diagnostic Steps**:
1. Check Gemini API status
2. Verify API key validity
3. Test network connectivity to Google APIs
4. Check application logs

**Resolution Steps**:
```bash
# Check Gemini API status
curl -X GET "https://generativelanguage.googleapis.com/v1/models" \
  -H "x-goog-api-key: YOUR_API_KEY"

# Check API key usage
# Visit: https://makersuite.google.com/app/apikey

# Test network connectivity
ping generativelanguage.googleapis.com
telnet generativelanguage.googleapis.com 443

# Check application logs
grep "Gemini\|voice\|audio" /var/log/myra/server.log | tail -20
```

**Verification**:
```bash
# Test voice response with curl
curl -X POST "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent" \
  -H "x-goog-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "parts": [{"text": "Say hello"}]
    }]
  }'
```

### Procedure 3: Poor Voice Recognition

**Symptoms**:
- Incorrect transcriptions
- Words missed or garbled
- Low accuracy in noisy environments

**Diagnostic Steps**:
1. Check audio quality
2. Test with different microphones
3. Check background noise
4. Verify sample rate and format

**Resolution Steps**:
```bash
# Check audio configuration
# Myra uses: PCM16, 16kHz, mono

# Test audio capture quality
# Use audacity or similar to record and analyze

# Adjust microphone settings
# - Reduce gain if clipping
# - Enable noise suppression
# - Use headset instead of built-in mic
```

**Audio Quality Checklist**:
- [ ] Microphone within 6-12 inches
- [ ] Quiet environment
- [ ] No echo/reverb
- [ ] Proper sample rate (16kHz)
- [ ] Mono channel (not stereo)

### Procedure 4: Audio Cutting Out

**Symptoms**:
- Audio drops during conversation
- Intermittent voice recognition
- Choppy audio playback

**Diagnostic Steps**:
1. Check network stability
2. Monitor WebSocket connection
3. Check CPU/memory usage
4. Verify audio buffer settings

**Resolution Steps**:
```bash
# Check network stability
ping -c 10 google.com
# Look for packet loss or high latency

# Monitor WebSocket connections
netstat -tulpn | grep :3000

# Check system resources
top -b -n 1 | grep -E "(node|myra)"

# Adjust audio chunk size if needed
# Default: 100ms chunks (1600 samples at 16kHz)
```

**Network Requirements**:
- Minimum: 64 kbps upload
- Recommended: 128 kbps upload
- Latency: < 200ms
- Packet loss: < 1%

### Procedure 5: Voice Activity Detection Issues

**Symptoms**:
- Myra interrupts user
- Doesn't detect end of speech
- False positives/negatives

**Diagnostic Steps**:
1. Check VAD sensitivity settings
2. Test with different speaking styles
3. Monitor silence detection
4. Check audio preprocessing

**Resolution Steps**:
```typescript
// Adjust VAD parameters if accessible
const vadSettings = {
  silenceTimeout: 1400, // ms of silence to detect end
  voiceThreshold: 0.02, // audio level threshold
  minVoiceDuration: 200 // ms minimum voice duration
};

// Environmental adjustments
// Increase timeout in noisy environments
// Decrease timeout in quiet environments
```

**VAD Tuning Guide**:
- **Noisy environment**: Increase silence timeout to 2000ms
- **Quiet environment**: Decrease silence timeout to 1000ms
- **Fast talkers**: Decrease min voice duration to 100ms
- **Slow talkers**: Increase min voice duration to 300ms

## Advanced Troubleshooting

### Network Issues
```bash
# Comprehensive network test
mtr generativelanguage.googleapis.com
# Check for routing issues

# Test WebSocket connectivity
websocat ws://localhost:3000/ws
# Verify WebSocket handshake

# Check firewall rules
sudo iptables -L -n
# Ensure port 3000 is open
```

### Hardware Issues
```bash
# List audio devices
# Windows: soundrecorder /?
# macOS: system_profiler SPAudioDataType
# Linux: arecord -l

# Test microphone hardware
# Windows: Control Panel > Sound > Recording
# macOS: Audio MIDI Setup
# Linux: pavucontrol

# Check driver issues
# Update audio drivers
# Reinstall if necessary
```

### Configuration Issues
```bash
# Check .env configuration
cat .env | grep -E "(GEMINI|VOICE|AUDIO)"

# Verify required variables
# GEMINI_API_KEY must be set
# AI_PROVIDER should be 'gemini'
# PORT should be 3000 (default)

# Check Electron configuration
# Ensure microphone access in package.json
# Check native module compatibility
```

## Performance Optimization

### Optimize for Low-End Hardware
```bash
# Reduce audio quality if needed
# Change from 16kHz to 8kHz (if supported)
# Reduce chunk size from 100ms to 50ms

# Limit concurrent voice sessions
# Set MAX_CONCURRENT_VOICE_SESSIONS=1

# Enable hardware acceleration if available
# Check GPU support for audio processing
```

### Optimize for Network Conditions
```bash
# Enable audio compression
# If high latency: increase buffer size
# If packet loss: enable FEC (if available)

# Adjust chunk size dynamically
# Good network: 100ms chunks
# Poor network: 50ms chunks (more overhead)
```

## Log Analysis

### Common Error Messages
```
# Permission denied
"NotAllowedError: Permission denied"

# Network issues  
"NetworkError: Failed to fetch"
"WebSocket is not open"

# API errors
"GoogleGenerativeAIError: API key invalid"
"429 Too Many Requests"

# Audio processing
"AudioBuffer error"
"Sample rate mismatch"
```

### Log Collection
```bash
# Collect relevant logs
grep -E "(voice|audio|microphone|speech)" /var/log/myra/server.log > voice_issues.log

# Check WebSocket logs
grep "WebSocket\|/ws" /var/log/myra/server.log | tail -50

# Check error rates
grep "ERROR\|WARN" /var/log/myra/server.log | grep -i voice | tail -20
```

### Debug Mode
```bash
# Enable verbose logging
export LOG_LEVEL=debug
export DEBUG=voice*,audio*

# Restart with debug
pm2 restart myra-server --update-env

# Monitor in real-time
pm2 logs myra-server --lines 100 --timestamp
```

## Testing Procedures

### Smoke Test
```bash
# Complete voice system test
1. Start Myra
2. Click microphone button
3. Speak: "Hello Myra"
4. Verify: Listening indicator shows
5. Verify: Transcription appears
6. Verify: Response audio plays
7. Verify: Response text displays

# Expected time: < 5 seconds end-to-end
```

### Regression Test
```bash
# Test after fixes
1. Test with different phrase lengths
2. Test in noisy environment
3. Test with headset vs built-in mic
4. Test network disconnect/reconnect
5. Test multiple consecutive queries

# Success criteria: 90%+ accuracy
```

### Load Test
```bash
# Simulate multiple users
# Use artillery or similar tool
artillery run voice_load_test.yml

# Monitor:
# - Response latency
# - Error rate
# - Resource usage
# - Audio quality
```

## User Communication

### Status Messages to User
```
Initial Issue: "Checking microphone access..."
Network Issue: "Connecting to voice service..."
API Issue: "Voice service temporarily unavailable"
Success: "Ready to listen"

Error: "Microphone access required. Please check permissions."
Error: "Network connection needed for voice features."
Error: "Voice service error. Try again in a moment."
```

### User Guidance
```
For Microphone Issues:
1. Check browser/OS microphone permissions
2. Ensure microphone is not muted
3. Try a different microphone
4. Restart the application

For Network Issues:
1. Check internet connection
2. Try disabling VPN/proxy
3. Check firewall settings
4. Try different network

For Quality Issues:
1. Speak clearly and at normal pace
2. Reduce background noise
3. Use headset for better quality
4. Position microphone properly
```

## Prevention & Monitoring

### Proactive Monitoring
```bash
# Daily checks
# - Voice success rate > 95%
# - Response latency < 2s P95
# - Error rate < 1%
# - API key validity

# Automated alerts
# - Voice failure rate > 5%
# - High latency > 5s
# - API quota approaching limit
# - Microphone permission changes
```

### Preventive Maintenance
```bash
# Weekly
# - Test all voice features
# - Review error logs
# - Check API usage quotas
# - Update dependencies

# Monthly
# - Test with different hardware
# - Review performance metrics
# - Update troubleshooting guides
# - Backup configurations
```

## Recovery Procedures

### Complete Voice Failure
```bash
# If voice completely broken
1. Check Gemini API status page
2. Verify API key not revoked
3. Check for service outages
4. Roll back recent changes
5. Implement fallback mode

# Fallback mode: Text-only interface
# Disable voice features temporarily
# Show clear message to users
```

### Partial Recovery
```bash
# If some users affected
1. Identify common factors
2. Check geographic patterns
3. Test with different accounts
4. Implement workarounds

# Workarounds:
# - Alternative voice model
# - Reduced audio quality
# - Increased timeouts
```

## Training & Documentation

### Team Training
- Voice system architecture
- Common troubleshooting steps
- Log analysis techniques
- User communication protocols

### User Documentation
- Microphone setup guide
- Voice feature overview
- Troubleshooting common issues
- Accessibility features

### Knowledge Base Articles
1. "Setting up your microphone"
2. "Improving voice recognition"
3. "Voice privacy and security"
4. "Troubleshooting voice issues"

## Metrics & KPIs

### Voice System KPIs
- Success rate: > 95%
- Response latency: < 2s P95
- Word error rate: < 10%
- User satisfaction: > 4/5 stars

### Monitoring Metrics
- Active voice sessions
- API request rate
- Error types and frequencies
- Resource utilization

### Improvement Tracking
- Issue recurrence rate
- Mean time to resolution
- User-reported issues
- Feature usage patterns

---

*Voice System Troubleshooting Runbook v1.0*
*Last Updated: 2026-11-24*
*Based on Runbooks Prompt Framework*