class DonationsManager {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        
        this.init();
    }

    init() {
        this.connectWebSocket();
        this.loadInitialData();
        this.setupEventListeners();
        this.startPeriodicRefresh();
    }

    connectWebSocket() {
        const wsPort = window.location.hostname === 'localhost' ? '8080' : '8080';
        const wsUrl = `ws://${window.location.hostname}:${wsPort}`;
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.updateConnectionStatus();
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleWebSocketMessage(message);
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                }
            };

            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                this.isConnected = false;
                this.updateConnectionStatus();
                this.handleReconnect();
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.isConnected = false;
                this.updateConnectionStatus();
            };

        } catch (error) {
            console.error('Error creating WebSocket:', error);
            this.handleReconnect();
        }
    }

    handleWebSocketMessage(message) {
        if (message.type === 'new_donation') {
            this.handleNewDonation(message.data);
        }
    }

    handleNewDonation(donation) {
        this.showNotification(`Новий донат від ${donation.name}: ${donation.amount} UAH`);
        this.addDonationToList(donation, true);
        this.refreshStats();
        this.refreshTopDonors();
    }

    handleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Reconnecting... Attempt ${this.reconnectAttempts}`);
            
            setTimeout(() => {
                this.connectWebSocket();
            }, this.reconnectDelay * this.reconnectAttempts);
        } else {
            console.log('Max reconnection attempts reached');
        }
    }

    updateConnectionStatus() {
        const statusElement = document.querySelector('.connection-status');
        if (statusElement) {
            statusElement.textContent = this.isConnected ? '🟢 Підключено' : '🔴 Відключено';
            statusElement.className = `connection-status ${this.isConnected ? 'connected' : 'disconnected'}`;
        }
    }

    async loadInitialData() {
        try {
            await Promise.all([
                this.refreshStats(),
                this.refreshRecentDonations(),
                this.refreshTopDonors()
            ]);
        } catch (error) {
            console.error('Error loading initial data:', error);
        }
    }

    async refreshStats() {
        try {
            const response = await fetch('/api/donations/stats');
            const stats = await response.json();
            
            document.getElementById('total-amount').textContent = `${stats.totalAmount.toLocaleString('uk-UA')} ₴`;
            document.getElementById('total-count').textContent = stats.totalCount.toLocaleString('uk-UA');
            document.getElementById('unique-donors').textContent = stats.uniqueDonors.toLocaleString('uk-UA');
        } catch (error) {
            console.error('Error fetching stats:', error);
        }
    }

    async refreshRecentDonations() {
        try {
            const response = await fetch('/api/donations/recent?limit=20');
            const donations = await response.json();
            
            const list = document.getElementById('recent-donations');
            list.innerHTML = '';
            
            donations.forEach(donation => {
                this.addDonationToList(donation, false);
            });
        } catch (error) {
            console.error('Error fetching recent donations:', error);
        }
    }

    async refreshTopDonors() {
        try {
            const response = await fetch('/api/donations/top?limit=10');
            const topDonors = await response.json();
            
            const list = document.getElementById('top-donors');
            list.innerHTML = '';
            
            topDonors.forEach((donor, index) => {
                const item = document.createElement('div');
                item.className = 'top-donor';
                item.innerHTML = `
                    <div class="donor-rank">${index + 1}</div>
                    <div class="donor-name">${donor.name}</div>
                    <div class="donation-amount">${donor.amount.toLocaleString('uk-UA')} ₴</div>
                `;
                list.appendChild(item);
            });
        } catch (error) {
            console.error('Error fetching top donors:', error);
        }
    }

    addDonationToList(donation, isNew = false) {
        const list = document.getElementById('recent-donations');
        const item = document.createElement('li');
        item.className = `donation-item ${isNew ? 'new-donation' : ''}`;
        
        const time = donation.time || new Date(donation.timestamp).toLocaleString('uk-UA');
        
        let html = `
            <div class="donation-header">
                <span class="donor-name">${donation.name}</span>
                <span class="donation-amount">${donation.amount.toLocaleString('uk-UA')} ₴</span>
            </div>
            <div class="donation-time">${time}</div>
        `;
        
        // Додаємо опис платежу
        if (donation.description) {
            html += `<div class="donation-description">${donation.description}</div>`;
        }
        
        // Додаємо коментар якщо він є
        if (donation.comment && donation.comment.trim()) {
            html += `<div class="donation-comment">💬 "${donation.comment}"</div>`;
        }
        
        // Додаємо інформацію про відправника якщо вона відрізняється
        if (donation.counterName && donation.counterName !== donation.name && donation.counterName !== 'Невідомий відправник') {
            html += `<div class="donation-sender">📤 від ${donation.counterName}</div>`;
        }
        
        item.innerHTML = html;
        
        if (isNew) {
            list.insertBefore(item, list.firstChild);
            setTimeout(() => {
                item.classList.remove('new-donation');
            }, 3000);
        } else {
            list.appendChild(item);
        }
    }

    showNotification(message) {
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideInDown 0.5s ease reverse';
            setTimeout(() => {
                document.body.removeChild(notification);
            }, 500);
        }, 3000);
    }

    async testDonation() {
        try {
            const response = await fetch('/api/test-donation');
            const result = await response.json();
            
            if (result.success) {
                this.showNotification('Тестовий донат створено!');
            }
        } catch (error) {
            console.error('Error creating test donation:', error);
            this.showNotification('Помилка створення тестового донату');
        }
    }

    setupEventListeners() {
        document.getElementById('refresh-btn')?.addEventListener('click', () => {
            this.loadInitialData();
        });
        
        document.getElementById('test-btn')?.addEventListener('click', () => {
            this.testDonation();
        });
    }

    startPeriodicRefresh() {
        setInterval(() => {
            if (!this.isConnected) {
                this.refreshStats();
                this.refreshRecentDonations();
                this.refreshTopDonors();
            }
        }, 30000);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new DonationsManager();
});