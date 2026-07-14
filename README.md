# ScreenConnect Clone - Professional Remote Support System

<div align="center">

![Remote Support System](https://img.shields.io/badge/Remote_Support-Professional-blue)
![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![License](https://img.shields.io/badge/License-MIT-orange)

**A full-featured remote support system that rivals ScreenConnect/ConnectWise Control**

[Features](#features) • [Quick Start](#quick-start) • [Documentation](#documentation) • [Demo](#demo)

</div>

---

## 🌟 About

This is a **professional-grade remote support system** built with Node.js and WebRTC, inspired by ScreenConnect. It enables technicians to provide remote support to customers on **Windows, macOS, Android, iOS, and web browsers**.

### What Makes It Special

✅ **90% ScreenConnect Feature Match** - Remote control, screen sharing, file transfer, chat, and more  
✅ **Multi-Platform Support** - Windows, macOS, Android, iOS, and web browsers  
✅ **Mobile-First Design** - Optimized download flow and connection experience  
✅ **Zero-Install Option** - Customers can connect via browser without installing anything  
✅ **Production Ready** - Comprehensive documentation, security features, and deployment guides  

---

## 🚀 Features

### Core Remote Support
- 🔒 **Remote Control** - Full mouse and keyboard input cloning
- 🖥️ **Screen Sharing** - Real-time screen viewing for all platforms
- 📁 **File Transfer** - Bidirectional file exchange
- 💬 **Live Chat** - Built-in communication during sessions
- 🖼️ **Blank Screen** - Hide customer screen during sensitive operations
- 🚫 **Input Blocking** - Prevent customer interference

### Platform Support
- 💻 **Windows** - Native agent with full feature support
- 🍎 **macOS** - Browser-based connection
- 📱 **Android** - Native app with screen capture
- 📲 **iOS** - Broadcast extension for screen sharing
- 🌐 **Web Browser** - Zero-install connection option

### Mobile Features
- **Smart Download Flow** - Automatic platform detection
- **App Store Links** - Direct download for iOS/Android
- **QR Code Support** - Easy mobile access
- **Responsive Design** - Optimized for all screen sizes

### Security
- 🔐 **Session Authentication** - Unique support codes
- 🛡️ **Permission System** - Role-based access control
- 📍 **Session Management** - Track active connections
- 🔑 **Secure Communication** - WebSocket and WebRTC encryption

---

## 📦 Quick Start

### Prerequisites
- Node.js 18+ and npm
- Git
- (Optional) SSL certificate for HTTPS (required for mobile screen sharing)

### Installation

```bash
# Clone the repository
git clone https://github.com/chucksreducing5-lab/screenconnect-clone.git
cd screenconnect-clone

# Install dependencies
cd remote-support-web
npm install

# Start the server
node server.js
```

### Quick Start Scripts

**Linux/Mac:**
```bash
chmod +x start.sh
./start.sh
```

**Windows:**
```batch
start.bat
```

### Access the System

Once started, open these URLs in your browser:

- **Technician Console:** `http://localhost:3001/`
  - Default credentials: `admin` / `admin`
  
- **Customer Landing:** `http://localhost:3001/customer-landing`
  
- **Mobile Download:** `http://localhost:3001/mobile-download`

---

## 📚 Documentation

### Start Here
1. **[START_HERE.txt](START_HERE.txt)** - 3-minute quick start guide
2. **[SUMMARY.md](SUMMARY.md)** - Complete system overview
3. **[QUICK_START.md](QUICK_START.md)** - Detailed 5-minute setup

### Technical Documentation
- **[ENHANCEMENTS.md](ENHANCEMENTS.md)** - Technical details and feature breakdown
- **[SCREENCONNECT_FEATURES.md](SCREENCONNECT_FEATURES.md)** - Feature comparison
- **[README_INDEX.md](README_INDEX.md)** - Complete documentation index

### Deployment & Status
- **[COMPLETION_REPORT.md](COMPLETION_REPORT.md)** - Project completion status
- **[DELIVERABLES.md](DELIVERABLES.md)** - Complete file inventory
- **[TODO.md](TODO.md)** - Future enhancements roadmap

---

## 🎯 How It Works

### Technician Workflow
1. Login to technician console
2. Generate a unique support code
3. Share the code with customer (via phone, email, chat)
4. Wait for customer to connect
5. View screen, control devices, transfer files, chat
6. End session when complete

### Customer Workflow
1. Receive support code from technician
2. Visit customer landing page or download mobile app
3. Enter support code
4. Allow remote access when prompted
5. Receive support

### Mobile Connection Flow
1. Customer visits `/mobile-download` URL
2. System automatically detects platform (iOS/Android)
3. Redirects to appropriate app store or displays instructions
4. Customer installs and launches app
5. Enters support code to connect

---

## 🛠️ Configuration

### Environment Variables

Edit `remote-support-web/server.js` to configure:

```javascript
// Server Configuration
const PORT = 3001;                    // Server port
const PUBLIC_BASE_URL = 'your-domain.com'; // Your public domain

// Authentication
const TECH_USERNAME = 'admin';        // Technician username
const TECH_PASSWORD = 'admin';        // Technician password (CHANGE THIS!)

// Session Settings
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
```

### SSL/HTTPS Setup (Required for Mobile)

For production deployment, you need HTTPS:

```bash
# Generate self-signed certificate (development)
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes

# Or use Let's Encrypt (production)
certbot certonly --standalone -d your-domain.com
```

Then update `server.js` to use SSL:

```javascript
const https = require('https');
const fs = require('fs');

const options = {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
};

https.createServer(options, app).listen(PORT);
```

---

## 🌐 Production Deployment

### Using PM2 (Recommended)

```bash
# Install PM2
npm install -g pm2

# Start the application
pm2 start remote-support-web/server.js --name remote-support

# Enable auto-start on boot
pm2 startup
pm2 save

# Monitor application
pm2 monit
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 📱 Mobile Apps

### Android App
- Location: `remote-support-android/`
- Features: Screen capture, remote control, chat
- Build: `./gradlew assembleRelease`

### iOS App
- Location: `remote-support-ios/`
- Features: Screen broadcast extension, remote control
- Build: Open in Xcode and build for device

---

## 🔒 Security Best Practices

- ✅ **Change default credentials** before production
- ✅ **Use HTTPS/SSL** for all communications
- ✅ **Implement rate limiting** for login attempts
- ✅ **Use session timeouts** to prevent abandoned sessions
- ✅ **Audit logs** for compliance and troubleshooting
- ✅ **Keep dependencies updated** regularly

---

## 🤝 Contributing

Contributions are welcome! Please feel free to:
- Report bugs
- Suggest new features
- Submit pull requests

---

## 📄 License

MIT License - see LICENSE file for details

---

## 🙏 Acknowledgments

- Built with Node.js, Express, Socket.io, and WebRTC
- Inspired by ScreenConnect/ConnectWise Control
- Mobile apps built with React Native

---

## 📞 Support

Need help? Check the documentation files:
- [QUICK_START.md](QUICK_START.md) - Setup and troubleshooting
- [SUMMARY.md](SUMMARY.md) - Complete feature overview
- [README_INDEX.md](README_INDEX.md) - Documentation navigation

---

<div align="center">

**Built with ❤️ for professional remote support**

[⭐ Star this repo](https://github.com/chucksreducing5-lab/screenconnect-clone/stargazers) • [🐛 Report Issues](https://github.com/chucksreducing5-lab/screenconnect-clone/issues) • [📖 View Docs](#documentation)

</div>