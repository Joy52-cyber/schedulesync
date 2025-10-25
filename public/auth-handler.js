// auth-handler.js - Handles OAuth token from URL parameters

(function() {
    console.log('🔧 Auth handler loaded');
    console.log('Current page:', window.location.pathname);
    console.log('Full URL:', window.location.href);
    
    // FIRST: Check if there's a token in the URL and save it
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    
    if (token) {
        console.log('✅ Token found in URL:', token.substring(0, 20) + '...');
        // Save token to localStorage
        localStorage.setItem('token', token);
        console.log('✅ Token saved to localStorage');
        
        // Remove token from URL for security
        const url = new URL(window.location);
        url.searchParams.delete('token');
        url.searchParams.delete('google');
        url.searchParams.delete('microsoft');
        window.history.replaceState({}, document.title, url);
        console.log('✅ Token removed from URL');
        console.log('✅ OAuth sign-in successful - staying on', window.location.pathname);
        // Don't redirect - let the page load normally
        return; // Exit early - we're good!
    }
    
    // SECOND: Check if user is already authenticated (no token in URL)
    const existingToken = localStorage.getItem('token');
    console.log('Existing token in localStorage:', existingToken ? 'YES' : 'NO');
    
    if (existingToken) {
        console.log('✅ User is authenticated');
        
        // If on login page and already authenticated, redirect to dashboard
        if (window.location.pathname === '/login' || window.location.pathname === '/') {
            console.log('🔄 Already logged in - redirecting to dashboard...');
            window.location.href = '/dashboard';
        }
    } else {
        console.log('ℹ️ User is not authenticated');
        
        // If on protected page and not authenticated, redirect to login
        const protectedPages = ['/dashboard', '/calendar-setup', '/settings', '/availability', '/bookings'];
        if (protectedPages.includes(window.location.pathname)) {
            console.log('⚠️ Protected page without token - redirecting to login...');
            window.location.href = '/login';
        }
    }
})();