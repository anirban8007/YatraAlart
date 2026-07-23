/**
 * YatraAlart - Real-time GPS Tracking with Train Detection
 * This script handles all tracking logic including:
 * - GPS location updates every 30 seconds
 * - Distance calculation from source
 * - Train detection and alerting
 * - Real-time UI updates
 */

// Global tracking state
let trackingState = {
    isTracking: false,
    userId: null,
    locationWatchId: null,
    updateInterval: null,
    currentLocation: null,
    sourceLocation: null,
    startTime: null
};

// Train detection state
let trainDetectionState = {
    consecutiveDetections: 0,
    detectionHistory: [],
    alertTriggered: false,
    lastCheckTime: null
};

/**
 * Initialize tracking session with initial location
 */
async function initializeTracking(position) {
    try {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;
        
        console.log(`Initial location: ${lat}, ${lng} (accuracy: ${accuracy}m)`);
        
        // Generate user ID (can be UUID in production)
        const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Call backend to start tracking
        const response = await fetch('/track/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                lat: lat,
                lng: lng,
                user_id: userId
            })
        });
        
        if (!response.ok) {
            throw new Error(`Backend error: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('Tracking session started:', data);
        
        // Update tracking state
        trackingState.isTracking = true;
        trackingState.userId = userId;
        trackingState.sourceLocation = { lat, lng };
        trackingState.currentLocation = { lat, lng };
        trackingState.startTime = Date.now();
        
        // Reset train detection
        trainDetectionState.consecutiveDetections = 0;
        trainDetectionState.detectionHistory = [];
        trainDetectionState.alertTriggered = false;
        
        // Update UI
        updateTrackingUI({
            status: 'Tracking started',
            distance_from_source_m: 0,
            current_route: null,
            railway_detection: {
                found: false,
                consecutive_detections: 0
            },
            train_alert: false
        });
        
        // Start periodic location updates (every 30 seconds)
        startPeriodicLocationUpdates();
        
    } catch (error) {
        console.error('Error initializing tracking:', error);
        alert('Failed to start tracking: ' + error.message);
        
        // Reset UI
        document.getElementById('start-tracking-btn').classList.remove('hidden');
        document.getElementById('stop-tracking-btn').classList.add('hidden');
        document.getElementById('mobile-start-tracking-btn').classList.remove('hidden');
        document.getElementById('mobile-stop-tracking-btn').classList.add('hidden');
    }
}

/**
 * Start periodic location updates every 30 seconds
 */
function startPeriodicLocationUpdates() {
    // Get initial location immediately
    getAndUpdateLocation();
    
    // Then set interval for 30 seconds
    trackingState.updateInterval = setInterval(() => {
        getAndUpdateLocation();
    }, 30000); // 30 seconds
}

/**
 * Get current location and update backend
 */
function getAndUpdateLocation() {
    if (!trackingState.isTracking) {
        return;
    }
    
    navigator.geolocation.getCurrentPosition(
        async (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            
            console.log(`Location update: ${lat}, ${lng}`);
            
            try {
                // Call backend to update tracking
                const response = await fetch('/track/update', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        lat: lat,
                        lng: lng,
                        user_id: trackingState.userId
                    })
                });
                
                if (!response.ok) {
                    throw new Error(`Backend error: ${response.statusText}`);
                }
                
                const data = await response.json();
                console.log('Location update response:', data);
                
                // Update tracking state
                trackingState.currentLocation = { lat, lng };
                
                // Update train detection state
                trainDetectionState.consecutiveDetections = data.railway_detection.consecutive_detections;
                trainDetectionState.detectionHistory.push({
                    timestamp: new Date().toISOString(),
                    found: data.railway_detection.found,
                    count: trainDetectionState.consecutiveDetections
                });
                
                // Update UI with new data
                updateTrackingUI(data);
                
                // Check if train alert should be triggered
                if (data.train_alert && !trainDetectionState.alertTriggered) {
                    trainDetectionState.alertTriggered = true;
                    showTrainAlert(data.alert_message);
                }
                
            } catch (error) {
                console.error('Error updating location:', error);
                updateStatus('Error updating location', 'error');
            }
        },
        (error) => {
            console.error('Geolocation error:', error);
            updateStatus('Location access denied', 'error');
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        }
    );
}

/**
 * Stop tracking and get trip summary
 */
async function stopTracking() {
    if (!trackingState.isTracking) {
        return;
    }
    
    try {
        // Stop periodic updates
        if (trackingState.updateInterval) {
            clearInterval(trackingState.updateInterval);
        }
        
        // Call backend to stop tracking
        const response = await fetch('/track/stop', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_id: trackingState.userId
            })
        });
        
        if (!response.ok) {
            throw new Error(`Backend error: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('Tracking stopped:', data);
        
        // Calculate trip duration
        const endTime = Date.now();
        const durationSeconds = Math.floor((endTime - trackingState.startTime) / 1000);
        const durationMinutes = Math.floor(durationSeconds / 60);
        const durationHours = Math.floor(durationMinutes / 60);
        
        let durationStr = '';
        if (durationHours > 0) {
            durationStr = `${durationHours}h ${durationMinutes % 60}m`;
        } else {
            durationStr = `${durationMinutes}m`;
        }
        
        // Show trip summary
        showTripSummary({
            ...data.trip_summary,
            duration: durationStr,
            duration_seconds: durationSeconds,
            train_detections: trainDetectionState.consecutiveDetections,
            detection_history: trainDetectionState.detectionHistory
        });
        
        // Reset tracking state
        trackingState.isTracking = false;
        trackingState.userId = null;
        trackingState.currentLocation = null;
        trackingState.sourceLocation = null;
        trainDetectionState.consecutiveDetections = 0;
        trainDetectionState.alertTriggered = false;
        
        // Update UI
        updateStatus('Tracking stopped', 'info');
        
    } catch (error) {
        console.error('Error stopping tracking:', error);
        alert('Failed to stop tracking: ' + error.message);
    }
}

/**
 * Update tracking UI with latest data
 */
function updateTrackingUI(data) {
    // Update status
    if (data.railway_detection.found) {
        updateStatus(`🚂 Railways Detected (${data.railway_detection.consecutive_detections}/5)`, 'warning');
    } else {
        updateStatus('🛣️ No railways nearby', 'info');
    }
    
    // Update distance and time
    const distanceKm = (data.distance_from_source_m / 1000).toFixed(2);
    
    // Update desktop UI
    const timeValueElement = document.getElementById('time-value');
    const distanceValueElement = document.getElementById('distance-value');
    
    if (timeValueElement && distanceValueElement && data.current_route) {
        timeValueElement.textContent = data.current_route.time_str;
        distanceValueElement.textContent = `${data.current_route.distance_km} km`;
        
        // Show route panel
        document.getElementById('route-panel').classList.remove('hidden');
        document.getElementById('mobile-route-panel').classList.remove('hidden');
    }
    
    // Update detection panel
    if (data.railway_detection.found) {
        const detectionBadge = document.getElementById('result-badge');
        const detectionDetails = document.getElementById('result-details');
        const closestBox = document.getElementById('closest-box');
        
        if (detectionBadge) {
            detectionBadge.innerHTML = `
                <div style="color: #ff6b6b; font-size: 18px; font-weight: bold;">
                    🚂 RAILWAYS DETECTED
                </div>
            `;
        }
        
        if (detectionDetails) {
            const tracks = data.railway_detection.tracks || [];
            const stations = data.railway_detection.stations || [];
            
            detectionDetails.innerHTML = `
                <div style="margin-top: 10px;">
                    <p style="margin: 5px 0;"><strong>📊 Consecutive Detections:</strong> ${data.railway_detection.consecutive_detections}/5</p>
                    <p style="margin: 5px 0;"><strong>🛤️ Tracks Nearby:</strong> ${tracks.length}</p>
                    <p style="margin: 5px 0;"><strong>🚉 Stations Nearby:</strong> ${stations.length}</p>
                    <p style="margin: 5px 0;"><strong>📍 Distance from Source:</strong> ${distanceKm} km</p>
                </div>
            `;
        }
        
        if (closestBox && data.railway_detection.closest) {
            const closest = data.railway_detection.closest;
            closestBox.innerHTML = `
                <div style="margin-top: 10px; padding: 10px; background: #fff3cd; border-radius: 6px; border-left: 4px solid #ffc107;">
                    <p style="margin: 5px 0;"><strong>⚠️ Closest Railway:</strong></p>
                    <p style="margin: 5px 0;">Type: ${closest.type}</p>
                    <p style="margin: 5px 0;">Distance: ${closest.distance}m</p>
                </div>
            `;
        }
        
        document.getElementById('detection-panel').classList.remove('hidden');
        document.getElementById('mobile-detection-panel').classList.remove('hidden');
    } else {
        document.getElementById('detection-panel').classList.add('hidden');
        document.getElementById('mobile-detection-panel').classList.add('hidden');
    }
}

/**
 * Show train alert notification
 */
function showTrainAlert(message) {
    console.log('Train alert triggered:', message);
    
    // Play alert sound
    playAlertSound();
    
    // Show alert overlay
    const overlay = document.getElementById('alarm-overlay');
    const box = overlay.querySelector('.alarm-box');
    
    if (overlay) {
        const h2 = box.querySelector('h2');
        const p = box.querySelector('p');
        
        h2.textContent = '🚂 TRAIN DETECTED!';
        p.textContent = message;
        
        overlay.classList.remove('hidden');
        
        // Auto-dismiss after 5 seconds
        setTimeout(() => {
            overlay.classList.add('hidden');
        }, 5000);
    }
}

/**
 * Show trip summary after stopping tracking
 */
function showTripSummary(summary) {
    const summaryHTML = `
        <div style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); z-index: 1000; max-width: 400px; max-height: 80vh; overflow-y: auto;">
            <h2 style="text-align: center; color: #2c3e50;">📊 Trip Summary</h2>
            <hr>
            <div style="margin: 15px 0;">
                <p><strong>📍 Distance:</strong> ${summary.distance_m}m (${(summary.distance_m / 1000).toFixed(2)} km)</p>
                <p><strong>⏱️ Duration:</strong> ${summary.duration}</p>
                <p><strong>🚂 Train Detections:</strong> ${summary.train_detections}/5</p>
                ${summary.trip_info ? `
                    <p><strong>🛣️ Route Distance:</strong> ${summary.trip_info.distance_km} km</p>
                    <p><strong>⏰ Route Time:</strong> ${summary.trip_info.time_str}</p>
                ` : ''}
            </div>
            <hr>
            <div style="margin-top: 15px; padding: 10px; background: #ecf0f1; border-radius: 6px;">
                <p style="margin: 5px 0; font-size: 12px;"><strong>Source:</strong> (${summary.source.lat.toFixed(4)}, ${summary.source.lng.toFixed(4)})</p>
                <p style="margin: 5px 0; font-size: 12px;"><strong>Destination:</strong> (${summary.destination.lat.toFixed(4)}, ${summary.destination.lng.toFixed(4)})</p>
            </div>
            <button onclick="closeTripSummary()" style="width: 100%; margin-top: 15px; padding: 10px; background: #3498db; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">
                Close
            </button>
        </div>
    `;
    
    const container = document.createElement('div');
    container.id = 'trip-summary-overlay';
    container.innerHTML = summaryHTML;
    container.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 999; display: flex; align-items: center; justify-content: center;';
    
    document.body.appendChild(container);
}

/**
 * Close trip summary
 */
function closeTripSummary() {
    const overlay = document.getElementById('trip-summary-overlay');
    if (overlay) {
        overlay.remove();
    }
}

/**
 * Play alert sound
 */
function playAlertSound() {
    try {
        // Create audio context
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        // Set frequency and duration
        oscillator.frequency.value = 1000; // 1000 Hz beep
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
        
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.5);
    } catch (error) {
        console.warn('Could not play alert sound:', error);
    }
}

/**
 * Update status message
 */
function updateStatus(message, type = 'info') {
    const statusElement = document.getElementById('status');
    const mobileStatusElement = document.getElementById('mobile-status');
    
    const statusText = message;
    
    if (statusElement) {
        statusElement.textContent = statusText;
        statusElement.style.color = type === 'error' ? '#f44336' : type === 'warning' ? '#ff9800' : '#2196F3';
    }
    
    if (mobileStatusElement) {
        mobileStatusElement.textContent = statusText;
        mobileStatusElement.style.color = type === 'error' ? '#f44336' : type === 'warning' ? '#ff9800' : '#2196F3';
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    console.log('Tracking.js loaded');
    updateStatus('📡 Ready to start tracking', 'info');
});
