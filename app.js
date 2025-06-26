const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

// Email storage
const EMAILS_FILE = 'emails.json';
let lastWeatherData = null; // Store last weather data for comparison

// Initialize emails.json
async function initEmailsFile() {
  try {
    await fs.access(EMAILS_FILE);
  } catch {
    console.log('Creating new emails.json');
    await fs.writeFile(EMAILS_FILE, JSON.stringify([]));
  }
}

// Load emails
async function loadEmails() {
  await initEmailsFile();
  try {
    const data = await fs.readFile(EMAILS_FILE, 'utf8');
    if (!data.trim()) {
      console.log('emails.json is empty, returning empty array');
      return [];
    }
    return JSON.parse(data);
  } catch (error) {
    console.error('Error parsing emails.json:', error.message);
    return [];
  }
}

// Save emails
async function saveEmails(emails) {
  try {
    await fs.writeFile(EMAILS_FILE, JSON.stringify(emails, null, 2));
    console.log('Emails saved:', emails);
  } catch (error) {
    console.error('Error saving emails.json:', error.message);
    throw error;
  }
}

// Reverse geocode for location name
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse`;
    const res = await axios.get(url, {
      params: { format: 'json', lat, lon, zoom: 16, addressdetails: 1 },
      headers: { 'User-Agent': 'WeatherMailer/1.0' }
    });
    const addr = res.data.address;
    return [addr.neighbourhood, addr.suburb, addr.city, addr.state].filter(Boolean).join(', ');
  } catch (err) {
    console.error('Geocode failed:', err.message);
    return null;
  }
}

// Convert to Nepali digits
function toNepaliDigits(str) {
  const map = { '0': '०', '1': '१', '2': '२', '3': '३', '4': '४', '5': '५', '6': '६', '7': '७', '8': '८', '9': '९', '.': '.', '%': '%' };
  return str.toString().split('').map(c => map[c] ?? c).join('');
}

// Translate to Nepali
function translateToNepali(data) {
  const { locationName, conditionText, maxTemp, minTemp, humidity, precipitation, rainChance, rainStart, rainEnd, stormWarning } = data;

  const rainTime = rainStart && rainEnd
    ? `🕐 वर्षा ${rainStart} बजेदेखि ${rainEnd} बजेसम्म हुन सक्नेछ।`
    : `🕐 वर्षाको समय निश्चित छैन।`;

  const stormText = stormWarning ? `⚠️ मौसमी चेतावनी: ${stormWarning}` : '';

  return `
🙏 नमस्ते! क्रियातबाट आजको मौसम जानकारी:

📍 स्थान: ${locationName}
📝 मौसम: ${conditionText}

🌡️ न्यूनतम तापक्रम: ${toNepaliDigits(minTemp)}°C
🌡️ अधिकतम तापक्रम: ${toNepaliDigits(maxTemp)}°C
💧 आर्द्रता: ${toNepaliDigits(humidity)}%
🌧️ वर्षा: ${toNepaliDigits(precipitation)} मिमी
${rainTime}
☔ वर्षाको सम्भावना: ${toNepaliDigits(rainChance)}%

${stormText}
  `.trim();
}

// Format email message
function formatEmailMessage(data, isFollowUp = false) {
  const nepali = translateToNepali(data);

  const changes = isFollowUp && lastWeatherData
    ? `
Changes since last update:
${data.precipitation !== lastWeatherData.precipitation ? `- Precipitation: ${lastWeatherData.precipitation} mm → ${data.precipitation} mm\n` : ''}
${data.rainChance !== lastWeatherData.rainChance ? `- Chance of Rain: ${lastWeatherData.rainChance}% → ${data.rainChance}%\n` : ''}
${data.stormWarning !== lastWeatherData.stormWarning ? `- Storm Warning: ${lastWeatherData.stormWarning || 'None'} → ${data.stormWarning || 'None'}\n` : ''}
    `.trim()
    : '';

  const english = `
🙏 Namaste from Kriyaat! 🌤️

Here's your ${isFollowUp ? 'updated' : 'daily'} weather update:

📍 Location: ${data.locationName}
📝 Condition: ${data.conditionText}

🌡️ Min Temp: ${data.minTemp} °C
🌡️ Max Temp: ${data.maxTemp} °C
💧 Humidity: ${data.humidity}%
🌧️ Precipitation: ${data.precipitation} mm
🕐 Rain Timing: ${data.rainStart && data.rainEnd ? `${data.rainStart} - ${data.rainEnd}` : 'Not specified'}
☔ Chance of Rain: ${data.rainChance}%

${data.stormWarning ? `⚠️ Storm Alert: ${data.stormWarning}` : ''}

${isFollowUp && changes ? `-----------------------------
${changes}` : ''}

-----------------------------
${nepali}
  `.trim();

  return english;
}

// Fetch weather data
async function fetchWeatherData(lat, lon) {
  const apiKey = process.env.WEATHERAPI_KEY;
  const url = `http://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${lat},${lon}&days=1&alerts=yes`;

  try {
    const res = await axios.get(url);
    const data = res.data;
    const today = data.forecast.forecastday[0].day;
    const hourly = data.forecast.forecastday[0].hour;

    const rainHours = hourly.filter(h => h.chance_of_rain > 30 && h.precip_mm > 0);
    const rainStart = rainHours.length ? rainHours[0].time.split(' ')[1] : null;
    const rainEnd = rainHours.length ? rainHours[rainHours.length - 1].time.split(' ')[1] : null;

    const locationName = await reverseGeocode(lat, lon) || `${data.location.name}, ${data.location.region}`;
    const stormWarning = data.alerts?.alert?.[0]?.event
      ? `${data.alerts.alert[0].event} - ${data.alerts.alert[0].headline}`
      : '';

    const forecast = {
      locationName,
      conditionText: today.condition.text,
      maxTemp: today.maxtemp_c.toFixed(1),
      minTemp: today.mintemp_c.toFixed(1),
      humidity: today.avghumidity.toFixed(0),
      precipitation: today.totalprecip_mm.toFixed(1),
      rainChance: today.daily_chance_of_rain || 0,
      rainStart,
      rainEnd,
      stormWarning,
      heavyRainHour: hourly.find(h => h.precip_mm >= 2) // Trigger threshold
    };

    console.log(`Fetched weather data for lat:${lat}, lon:${lon}:`, forecast);
    return forecast;
  } catch (error) {
    console.error('API request failed:', error.message, error.response?.data);
    throw error;
  }
}

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_ADDRESS,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

// Send weather email
async function sendWeatherEmail(lat, lon, isFollowUp = false) {
  try {
    const emails = await loadEmails();
    if (!emails.length) {
      console.log('No registered emails to send updates to.');
      return;
    }

    const data = await fetchWeatherData(lat, lon);
    const message = formatEmailMessage(data, isFollowUp);

    for (const email of emails) {
      await transporter.sendMail({
        from: process.env.EMAIL_ADDRESS,
        to: email,
        subject: isFollowUp ? `🌤️ Weather Update from Kriyaat` : `🌤️ Daily Weather Update from Kriyaat`,
        text: message,
      });
      console.log(`📬 Email sent to ${email}${isFollowUp ? ' (follow-up)' : ''}`);
    }
    lastWeatherData = data; // Update last weather data

    if (!isFollowUp && data.heavyRainHour) {
      const rainTime = new Date(data.heavyRainHour.time);
      const notifyTime = new Date(rainTime.getTime() - 10 * 60 * 1000); // 10 min early
      const now = new Date();
      const delay = notifyTime - now;
      if (delay > 0) {
        console.log(`🔔 Scheduling heavy rain alert in ${Math.round(delay / 60000)} mins`);
        setTimeout(() => {
          emails.forEach(email => {
            transporter.sendMail({
              from: process.env.EMAIL_ADDRESS,
              to: email,
              subject: `🌧️ Alert from Kriyaat: Heavy rain expected soon`,
              text: `🙏 Namaste from Kriyaat!\n\n🌧️ Heavy rain expected around ${data.heavyRainHour.time.split(' ')[1]}.\nPlease be prepared and carry an umbrella ☂️.`,
            }).catch(err => console.error(`Failed to send heavy rain alert to ${email}:`, err.message));
          });
        }, delay);
      }
    }
  } catch (error) {
    console.error('Failed to send email:', error.message, error.stack);
  }
}

// Subscribe endpoint
app.post('/subscribe', async (req, res) => {
  console.log('Received subscription request:', req.body);
  const { email, lat = 27.7172, lon = 85.3240 } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ message: 'Invalid email' });
  }

  try {
    let emails = await loadEmails();
    if (!emails.includes(email)) {
      emails.push(email);
      await saveEmails(emails);
    }

    // Send initial email
    console.log(`Sending initial email for ${email}, lat:${lat}, lon:${lon}`);
    await sendWeatherEmail(lat, lon);
    // Schedule follow-up email after 3 hours
    console.log(`Scheduling follow-up email for ${email} in 3 hours`);
    setTimeout(() => {
      console.log(`Executing follow-up email for ${email}`);
      sendWeatherEmail(lat, lon, true);
    }, 3 * 60 * 60 * 1000); // 3 hours

    res.json({ message: 'Subscribed! You’ll get your updates soon.' });
  } catch (error) {
    console.error('Error subscribing:', error.message, error.stack);
    res.status(500).json({ message: 'Server error' });
  }
});

// Daily 7:15 AM (Nepal)
cron.schedule('15 1 * * *', () => {
  console.log('⏰ Sending daily update (7:15AM NPT)');
  sendWeatherEmail(27.7172, 85.3240);
}, { timezone: 'Asia/Kathmandu' });

// Debug route
app.get('*', (req, res) => {
  console.log('Requested:', req.url);
  res.status(404).send('Not Found');
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server ready at http://localhost:${port}`);
});