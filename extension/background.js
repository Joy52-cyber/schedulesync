// background.js - Service worker for extension

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('ScheduleSync installed!');
        // Open onboarding on install
        chrome.action.openPopup();
    } else if (details.reason === 'update') {
        console.log('ScheduleSync updated!');
    }
});

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'openDashboard') {
        chrome.tabs.create({ 
            url: 'https://schedulesync-production.up.railway.app/dashboard' 
        });
        sendResponse({ success: true });
    }
    
    if (request.action === 'calendarConnected') {
        // Handle calendar connection callback
        console.log('Calendar connected:', request.provider);
        
        // Store connection info
        chrome.storage.local.get('connectedCalendars', (result) => {
            const calendars = result.connectedCalendars || [];
            if (!calendars.includes(request.provider)) {
                calendars.push(request.provider);
                chrome.storage.local.set({ connectedCalendars: calendars });
            }
        });
        
        sendResponse({ success: true });
    }
    
    return true; // Keep channel open for async response
});

// Add context menu items
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'openScheduleSync',
        title: 'Open ScheduleSync Dashboard',
        contexts: ['all']
    });
    
    chrome.contextMenus.create({
        id: 'createBooking',
        title: 'Create New Booking',
        contexts: ['all']
    });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'openScheduleSync') {
        chrome.tabs.create({ 
            url: 'https://schedulesync-production.up.railway.app/dashboard' 
        });
    } else if (info.menuItemId === 'createBooking') {
        chrome.tabs.create({ 
            url: 'https://schedulesync-production.up.railway.app/teams' 
        });
    }
});

// Badge management
async function updateBadge() {
    try {
        // In a real implementation, fetch booking count from API
        const { token } = await chrome.storage.local.get('token');
        
        if (token) {
            // Fetch upcoming bookings count
            // const response = await fetch('https://schedulesync-production.up.railway.app/api/bookings/upcoming', {
            //     headers: { 'Authorization': `Bearer ${token}` }
            // });
            // const data = await response.json();
            // const count = data.bookings.length;
            
            // For now, just show example
            // chrome.action.setBadgeText({ text: String(count) });
            // chrome.action.setBadgeBackgroundColor({ color: '#764ba2' });
        }
    } catch (error) {
        console.error('Error updating badge:', error);
    }
}

// Update badge periodically
setInterval(updateBadge, 60000); // Every minute
updateBadge(); // Initial update