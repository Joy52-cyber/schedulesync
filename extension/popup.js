// popup.js - Extension popup logic

const DASHBOARD_URL = 'https://schedulesync-production.up.railway.app';

// State management
let currentStep = 1;
let userData = {
    usage: null,
    frequency: null,
    calendars: []
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Check if user has already completed onboarding
    const { onboardingComplete } = await chrome.storage.local.get('onboardingComplete');
    
    if (onboardingComplete) {
        // Show returning user view
        showReturningUserView();
    } else {
        // Show onboarding
        initializeOnboarding();
    }
});

// Initialize onboarding
function initializeOnboarding() {
    setupStep1();
    setupStep2();
    setupStep3();
}

// Step 1: Usage Questions
function setupStep1() {
    const options = document.querySelectorAll('#step1 .option');
    const nextBtn = document.getElementById('step1Next');
    
    let selectedUsage = null;
    let selectedFrequency = null;
    
    options.forEach(option => {
        option.addEventListener('click', () => {
            const parent = option.parentElement;
            const value = option.dataset.value;
            
            // Remove selected from siblings
            Array.from(parent.children).forEach(opt => opt.classList.remove('selected'));
            option.classList.add('selected');
            
            // Save selection
            const questionLabel = parent.previousElementSibling.textContent;
            if (questionLabel.includes('primarily use')) {
                selectedUsage = value;
                userData.usage = value;
            } else if (questionLabel.includes('meetings')) {
                selectedFrequency = value;
                userData.frequency = value;
            }
            
            // Enable next button if both selected
            if (selectedUsage && selectedFrequency) {
                nextBtn.disabled = false;
            }
        });
    });
    
    nextBtn.addEventListener('click', () => {
        goToStep(2);
    });
}

// Step 2: Calendar Connection
function setupStep2() {
    const googleBtn = document.getElementById('connectGoogle');
    const microsoftBtn = document.getElementById('connectMicrosoft');
    const nextBtn = document.getElementById('step2Next');
    const skipBtn = document.getElementById('step2Skip');
    
    googleBtn.addEventListener('click', () => connectCalendar('google', googleBtn));
    microsoftBtn.addEventListener('click', () => connectCalendar('microsoft', microsoftBtn));
    
    nextBtn.addEventListener('click', () => {
        goToStep(3);
    });
    
    skipBtn.addEventListener('click', () => {
        goToStep(3);
    });
}

// Connect calendar
async function connectCalendar(provider, button) {
    button.disabled = true;
    button.textContent = 'Connecting...';
    
    try {
        // Open OAuth flow in new tab
        const authUrl = provider === 'google' 
            ? `${DASHBOARD_URL}/api/calendar/google/auth`
            : `${DASHBOARD_URL}/api/calendar/microsoft/auth`;
        
        // Open auth page
        chrome.tabs.create({ url: authUrl });
        
        // Mark as connected (in real app, this would be confirmed via callback)
        setTimeout(() => {
            button.textContent = '✓ Connected';
            button.classList.add('connected');
            button.disabled = false;
            
            userData.calendars.push(provider);
            
            // Save to storage
            chrome.storage.local.set({ 
                connectedCalendars: userData.calendars 
            });
        }, 2000);
        
    } catch (error) {
        console.error('Calendar connection error:', error);
        button.textContent = 'Try Again';
        button.disabled = false;
    }
}

// Step 3: Complete
function setupStep3() {
    const openDashboardBtn = document.getElementById('openDashboard');
    const openBookingBtn = document.getElementById('openBooking');
    
    openDashboardBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: `${DASHBOARD_URL}/dashboard` });
    });
    
    openBookingBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: `${DASHBOARD_URL}/teams` });
    });
    
    // Update summary
    updateSummary();
}

// Update summary on step 3
function updateSummary() {
    const summaryList = document.getElementById('summaryList');
    
    let html = '<div class="connected-item"><span class="check-icon">✅</span><span>Profile configured</span></div>';
    
    if (userData.usage) {
        const usageText = {
            personal: 'Personal scheduling',
            team: 'Team management',
            business: 'Business meetings'
        };
        html += `<div class="connected-item"><span class="check-icon">✅</span><span>${usageText[userData.usage]}</span></div>`;
    }
    
    if (userData.calendars.length > 0) {
        userData.calendars.forEach(cal => {
            const calName = cal.charAt(0).toUpperCase() + cal.slice(1);
            html += `<div class="connected-item"><span class="check-icon">✅</span><span>${calName} Calendar connected</span></div>`;
        });
    }
    
    summaryList.innerHTML = html;
    
    // Mark onboarding as complete
    chrome.storage.local.set({ 
        onboardingComplete: true,
        userData: userData
    });
}

// Navigate between steps
function goToStep(stepNumber) {
    // Hide all steps
    document.querySelectorAll('.step').forEach(step => {
        step.classList.remove('active');
    });
    
    // Show target step
    document.getElementById(`step${stepNumber}`).classList.add('active');
    
    // Update progress dots
    document.querySelectorAll('.progress-dot').forEach((dot, index) => {
        if (index + 1 === stepNumber) {
            dot.classList.add('active');
        } else {
            dot.classList.remove('active');
        }
    });
    
    currentStep = stepNumber;
}

// Returning user view
function showReturningUserView() {
    document.querySelector('.container').innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <div style="font-size: 48px; margin-bottom: 16px;">⚡</div>
            <h1 style="font-size: 24px; margin-bottom: 8px;">ScheduleSync</h1>
            <p style="opacity: 0.9; margin-bottom: 24px;">Your scheduling assistant</p>
            
            <button class="btn-primary" id="dashboardBtn">Open Dashboard</button>
            <button class="btn-secondary" id="teamsBtn">My Teams</button>
            <button class="btn-secondary" id="bookingsBtn">View Bookings</button>
            <button class="btn-secondary" id="availabilityBtn">Set Availability</button>
            
            <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.2);">
                <button class="btn-secondary" id="resetBtn" style="background: rgba(255,255,255,0.1); font-size: 12px; padding: 8px;">
                    Reset Onboarding
                </button>
            </div>
        </div>
    `;
    
    // Add event listeners
    document.getElementById('dashboardBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: `${DASHBOARD_URL}/dashboard` });
    });
    
    document.getElementById('teamsBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: `${DASHBOARD_URL}/teams` });
    });
    
    document.getElementById('bookingsBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: `${DASHBOARD_URL}/bookings` });
    });
    
    document.getElementById('availabilityBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: `${DASHBOARD_URL}/availability` });
    });
    
    document.getElementById('resetBtn').addEventListener('click', async () => {
        await chrome.storage.local.clear();
        window.location.reload();
    });
}