#!/bin/bash

# Remote Support System - Quick Start Script
# This script starts the remote support server

echo "=========================================="
echo "  Remote Support System - Quick Start"
echo "=========================================="
echo ""

# Check if we're in the right directory
if [ ! -f "server.js" ]; then
    if [ -f "remote-support-web/server.js" ]; then
        cd remote-support-web
        echo "Changed to remote-support-web directory"
        echo ""
    else
        echo "Error: server.js not found!"
        echo "Please run this script from the remote-support-web directory"
        exit 1
    fi
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Node modules not found. Installing dependencies..."
    npm install
    echo ""
fi

# Display access URLs
echo "Starting Remote Support Server..."
echo ""
echo "🚀 Server will be available at:"
echo ""
echo "   Technician Console:  http://localhost:3001/"
echo "   Customer Landing:    http://localhost:3001/customer-landing"
echo "   Mobile Download:     http://localhost:3001/mobile-download"
echo "   Customer Page:       http://localhost:3001/customer"
echo ""
echo "Default Login:"
echo "   Username: admin"
echo "   Password: admin"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""
echo "=========================================="
echo ""

# Start the server
node server.js