let offlineMode = false;
let offlineCountdownInterval = null;

function goOffline() {
    offlineMode = true;
    showOffline(true);
    startOfflineCountdown();
}

function goOnline() {
    offlineMode = false;
    showOffline(false);
    clearInterval(offlineCountdownInterval);
}

function startOfflineCountdown() {
    if (!currentDurationMin) return;
    let remaining = currentDurationMin;
    clearInterval(offlineCountdownInterval);

    offlineCountdownInterval = setInterval(() => {
        if (!offlineMode) {
            clearInterval(offlineCountdownInterval);
            return;
        }

        // Decrease by 5 seconds worth of minutes every 5 seconds
        remaining = Math.max(0, remaining - (5 / 60));
        const mins = Math.round(remaining);
        const timeStr = mins >= 60
            ? `${Math.floor(mins / 60)}h ${mins % 60}min (est.)`
            : `${mins} min (est.)`;

        ["time-value", "mobile-time-value"].forEach(id => {
            const elem = document.getElementById(id);
            if (elem) elem.textContent = timeStr;
        });

        if (alarmSet) checkAlarmTrigger(remaining);
    }, 5000);
}

function checkInitialConnection() {
    if (!navigator.onLine) goOffline();
}

window.addEventListener("online", goOnline);
window.addEventListener("offline", goOffline);
checkInitialConnection();
