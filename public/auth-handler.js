// auth-handler.js - Handles OAuth token from URL parameters

(function() {
    // Check if there's a token in the URL
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    
    if (token) {
        // Save token to localStorage
        localStorage.setItem('token', token);
        console.log('✅ Token saved from OAuth redirect');
        
        // Remove token from URL for security
        const url = new URL(window.location);
        url.searchParams.delete('token');
        window.history.replaceState({}, document.title, url);
        
        // Optionally reload to trigger authenticated state
        if (window.location.pathname === '/dashboard') {
            console.log('✅ Authenticated - staying on dashboard');
        }
    }
    
    // Check if user is already authenticated
    const existingToken = localStorage.getItem('token');
    if (existingToken) {
        console.log('✅ User is authenticated');
        
        // If on login page and already authenticated, redirect to dashboard
        if (window.location.pathname === '/login' || window.location.pathname === '/') {
            window.location.href = '/dashboard';
        }
    } else {
        console.log('ℹ️ User is not authenticated');
        
        // If on protected page and not authenticated, redirect to login
        const protectedPages = ['/dashboard', '/calendar-setup', '/settings'];
        if (protectedPages.includes(window.location.pathname)) {
            window.location.href = '/login';
        }
    }
})();