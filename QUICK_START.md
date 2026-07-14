# Quick Start Guide - Remote Support System

## Installation & Setup (5 minutes)

### 1. Install Dependencies

```bash
cd remote-support-web
npm install
```

### 2. Start the Server

```bash
node server.js
```

The server will start on `http://0.0.0.0:3001`

### 3. Access the Interface

**Technician Console:**
```
http://localhost:3001/
```
Default credentials: `admin` / `admin`

**Customer Landing Page:**
```
http://localhost:3001/customer-landing
```

**Mobile Download Page:**
```
http://localhost:3001/mobile-download
```

## Basic Usage

### As a Technician

1. **Login to the Console**
   - Navigate to `http://localhost:3001/`
   - Login with username `admin` and password `admin`
   
2. **Create a Support Session**
   - Click "Generate support code"
   - Copy the customer link shown in the invite panel
   - Share with your customer

3. **Connect to Customer**
   - Wait for customer to join (status will update)
   - Click "Join" button to open the remote control view
   - Use toolbar buttons for:
     - CAD (Ctrl+Alt+Del)
     - Blank Screen
     - Block Guest Input
     - Transfer File
     - Record Session

4. **End Session**
   - Close the viewer window
   - Click "Delete" in session list to end completely

### As a Customer

**Option 1: Quick Browser Access (No Download)**
1. Go to the landing page: `http://localhost:3001/customer-landing`
2. Enter the support code (e.g., `AB12-CD34-EF56-GH78`)
3. Select "Web Browser"
4. Click "Join Session"
5. Grant screen sharing permissions when prompted
6. Session starts automatically

**Option 2: Mobile App (Better for Phones/Tablets)**
1. Go to mobile download page: `http://localhost:3001/mobile-download`
2. Download the app for your device (iOS/Android)
3. Open the app
4. Enter your session code
5. Allow screen sharing when prompted

**Option 3: Desktop Agent (Full Control)**
1. Go to customer page: `http://localhost:3001/customer`
2. Enter support code
3. Download the Windows agent
4. Run the downloaded installer
5. Approve UAC prompt
6. Session connects automatically

## Features Overview

### What Technicians Can Do
- ✅ View customer screen in real-time
- ✅ Control customer mouse and keyboard
- ✅ Send Ctrl+Alt+Del to customer
- ✅ Blank customer screen for privacy
- ✅ Block customer input during sensitive work
- ✅ Transfer files to/from customer
- ✅ Run commands on customer computer
- ✅ Chat with customer
- ✅ Record sessions (planned)
- ✅ View device information

### What Customers Experience
- ✅ Secure encrypted connection
- ✅ Clear session status indicators
- ✅ Easy join flow with code or link
- ✅ Multiple connection options
- ✅ Mobile-optimized interface
- ✅ Transparent permission requests
- ✅ Ability to end session anytime

## Session URL Examples

### With Support Code (Direct Join)
```
http://localhost:3001/customer-landing?code=AB12-CD34-EF56-GH78
```

### Mobile Download with Session Info
```
http://localhost:3001/mobile-download?sessionId=abc123&token=xyz789
```

### Direct Customer Join
```
http://localhost:3001/customer?code=AB12-CD34-EF56-GH78
```

## Configuration

### Change Default Credentials

Create a `.env` file or set environment variables:

```bash
export TECH_USERNAME=your_username
export TECH_PASSWORD=your_secure_password
export ADMIN_EMAIL=your_email@example.com
```

### Enable HTTPS (for Production)

```bash
# Generate self-signed certificate for testing
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 365

# Set certificate paths
export HTTPS_KEY=certs/key.pem
export HTTPS_CERT=certs/cert.pem

# Start server
node server.js
```

### Configure Public Base URL

For deployment behind a proxy or with a custom domain:

```bash
export PUBLIC_BASE_URL=https://support.yourdomain.com
export DOWNLOAD_BASE_URL=https://download.yourdomain.com
```

## Troubleshooting

### Server won't start
- Check if port 3001 is already in use
- Run `lsof -i :3001` to see what's using it
- Change port by setting `PORT=3002`

### Can't connect to customer
- Check firewall allows WebSocket connections
- Verify both technician and customer have internet access
- Check browser console for errors (F12)
- Try refreshing the page

### Screen sharing not working
- Ensure you granted permissions
- Check if browser supports screen sharing API
- Try a different browser (Chrome recommended)
- Clear browser cache and cookies

### File transfer failing
- Check file size limits in server configuration
- Verify customer has write permissions for download location
- Ensure network connection is stable
- Try smaller files first

## Testing Checklist

### Basic Functionality
- [ ] Server starts without errors
- [ ] Can login as technician
- [ ] Can create support session
- [ ] Can copy customer link
- [ ] Customer can join via browser
- [ ] Customer can join via mobile app
- [ ] Screen sharing works
- [ ] Remote mouse control works
- [ ] Remote keyboard control works
- [ ] Can end session

### Advanced Features
- [ ] File transfer works
- [ ] Chat functionality works
- [ ] Blank screen works
- [ ] Block input works
- [ ] Ctrl+Alt+Del works
- [ ] Can run commands
- [ ] Device info displays correctly
- [ ] Session history works
- [ ] Reconnects after disconnect

### Multi-Platform
- [ ] Works on Windows (Chrome/Edge)
- [ ] Works on macOS (Safari/Chrome)
- [ ] Works on Linux (Firefox/Chrome)
- [ ] Works on iOS (Mobile app)
- [ ] Works on Android (Mobile app)
- [ ] Works on mobile browsers

## Production Deployment

### Step 1: Obtain SSL Certificate
```bash
certbot certonly --standalone -d yourdomain.com
```

### Step 2: Configure Environment
```bash
export PORT=443
export HTTPS_KEY=/etc/letsencrypt/live/yourdomain.com/privkey.pem
export HTTPS_CERT=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
export PUBLIC_BASE_URL=https://yourdomain.com
```

### Step 3: Run with Process Manager
```bash
npm install -g pm2
pm2 start server.js --name remote-support
pm2 save
pm2 startup
```

### Step 4: Configure Firewall
```bash
sudo ufw allow 443/tcp
sudo ufw allow 80/tcp  # For Let's Encrypt renewal
```

### Step 5: Set Up Monitoring
```bash
pm2 logs remote-support
pm2 monit
```

## Support

For issues or questions:
1. Check the main README.md
2. Review ENHANCEMENTS.md for feature details
3. Check browser console for JavaScript errors
4. Check server logs for backend errors
5. Verify network connectivity and firewall settings

## Security Best Practices

1. **Change Default Credentials**: Update TECH_USERNAME and TECH_PASSWORD
2. **Use HTTPS**: Always use SSL certificates in production
3. **Enable Firewall**: Restrict access to necessary ports only
4. **Regular Updates**: Keep dependencies updated with `npm update`
5. **Monitor Sessions**: Review access logs regularly
6. **Strong Passwords**: Use complex passwords for all accounts
7. **Backup Data**: Regular backup of session data and configurations
8. **Rate Limiting**: Consider implementing rate limiting for login attempts
9. **Session Timeout**: Configure reasonable session timeouts
10. **Audit Logging**: Enable and review audit logs

## Quick Reference

| Task | Command/URL |
|------|-------------|
| Start Server | `node server.js` |
| Technician Console | `http://localhost:3001/` |
| Customer Landing | `http://localhost:3001/customer-landing` |
| Mobile Download | `http://localhost:3001/mobile-download` |
| Stop Server | Ctrl+C or `pkill -f "node server.js"` |
| Check Logs | Look at terminal output |
| Test Connection | Use browser dev tools (F12) |