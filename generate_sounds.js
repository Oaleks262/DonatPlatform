const fs = require('fs');
const path = require('path');
const lame = require('node-lame').Lame;

// Простий генератор WAV файлів для демонстрації
function generateBeep(frequency, duration, volume = 0.3, sampleRate = 44100) {
    const samples = Math.floor(sampleRate * duration);
    const buffer = Buffer.alloc(44 + samples * 2); // WAV header + 16-bit samples
    
    // WAV заголовок
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + samples * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20);  // PCM
    buffer.writeUInt16LE(1, 22);  // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32);  // block align
    buffer.writeUInt16LE(16, 34); // bits per sample
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples * 2, 40);
    
    // Генеруємо синусоїдальну хвилю
    for (let i = 0; i < samples; i++) {
        const t = i / sampleRate;
        const amplitude = Math.sin(2 * Math.PI * frequency * t) * volume;
        const sample = Math.round(amplitude * 32767);
        buffer.writeInt16LE(sample, 44 + i * 2);
    }
    
    return buffer;
}

function generateComplexSound(frequencies, durations, volume = 0.3) {
    const sampleRate = 44100;
    let totalSamples = 0;
    
    // Розраховуємо загальну кількість семплів
    durations.forEach(dur => {
        totalSamples += Math.floor(sampleRate * dur);
    });
    
    const buffer = Buffer.alloc(44 + totalSamples * 2);
    
    // WAV заголовок
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + totalSamples * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(totalSamples * 2, 40);
    
    let offset = 0;
    
    // Генеруємо кожну ноту
    for (let i = 0; i < frequencies.length; i++) {
        const freq = frequencies[i];
        const dur = durations[i];
        const samples = Math.floor(sampleRate * dur);
        
        for (let j = 0; j < samples; j++) {
            const t = j / sampleRate;
            const fade = Math.min(1, Math.min(j / (sampleRate * 0.05), (samples - j) / (sampleRate * 0.05))); // fade in/out
            const amplitude = Math.sin(2 * Math.PI * freq * t) * volume * fade;
            const sample = Math.round(amplitude * 32767);
            buffer.writeInt16LE(sample, 44 + (offset + j) * 2);
        }
        
        offset += samples;
    }
    
    return buffer;
}

// Створюємо папку для звуків
const soundsDir = path.join(__dirname, 'public', 'sounds');
if (!fs.existsSync(soundsDir)) {
    fs.mkdirSync(soundsDir, { recursive: true });
}

console.log('Генеруємо демонстраційні MP3 звуки...');

// Функція для конвертації WAV в MP3
async function convertToMp3(wavBuffer, outputPath) {
    const tempWavPath = path.join(__dirname, 'temp.wav');
    
    try {
        // Записуємо тимчасовий WAV файл
        fs.writeFileSync(tempWavPath, wavBuffer);
        
        // Конвертуємо в MP3
        const encoder = new lame({
            output: outputPath,
            bitrate: 128,
            quality: 2
        }).setFile(tempWavPath);
        
        await encoder.encode();
        
        // Видаляємо тимчасовий файл
        if (fs.existsSync(tempWavPath)) {
            fs.unlinkSync(tempWavPath);
        }
        
        return true;
    } catch (error) {
        console.error('Помилка конвертації в MP3:', error);
        // Видаляємо тимчасовий файл у разі помилки
        if (fs.existsSync(tempWavPath)) {
            fs.unlinkSync(tempWavPath);
        }
        return false;
    }
}

async function generateSounds() {
    try {
        console.log('Генеруємо WAV файли...');
        
        // Маленький донат - простий ding
        const tinySound = generateBeep(800, 0.3, 0.3);
        console.log('Конвертуємо tiny-donation в MP3...');
        await convertToMp3(tinySound, path.join(soundsDir, 'tiny-donation.mp3'));
        console.log('✅ tiny-donation.mp3 створено');
        
        // Середній донат - подвійний ding
        const smallSound = generateComplexSound([600, 800], [0.2, 0.3], 0.4);
        console.log('Конвертуємо small-donation в MP3...');
        await convertToMp3(smallSound, path.join(soundsDir, 'small-donation.mp3'));
        console.log('✅ small-donation.mp3 створено');
        
        // Великий донат - мелодія C-E-G
        const mediumSound = generateComplexSound([523, 659, 784], [0.3, 0.3, 0.4], 0.5);
        console.log('Конвертуємо medium-donation в MP3...');
        await convertToMp3(mediumSound, path.join(soundsDir, 'medium-donation.mp3'));
        console.log('✅ medium-donation.mp3 створено');
        
        // Максі донат - фанфари C-E-G-C
        const bigSound = generateComplexSound([523, 659, 784, 1047], [0.3, 0.3, 0.3, 0.6], 0.6);
        console.log('Конвертуємо big-donation в MP3...');
        await convertToMp3(bigSound, path.join(soundsDir, 'big-donation.mp3'));
        console.log('✅ big-donation.mp3 створено');
    
        console.log('\n🎵 Всі MP3 звуки створено успішно!');
        console.log('Файли знаходяться у папці public/sounds/');
        
        // Видаляємо старі WAV файли якщо вони є
        const wavFiles = ['tiny-donation.wav', 'small-donation.wav', 'medium-donation.wav', 'big-donation.wav'];
        wavFiles.forEach(file => {
            const wavPath = path.join(soundsDir, file);
            if (fs.existsSync(wavPath)) {
                fs.unlinkSync(wavPath);
                console.log(`🗑️ Видалено старий ${file}`);
            }
        });
        
        console.log('\nДля тестування:');
        console.log('1. Запустіть сервер: node server.js');
        console.log('2. Відкрийте: http://localhost:3000/obs');
        console.log('3. Клікніть на 🔊 та тестуйте звуки');
        
    } catch (error) {
        console.error('❌ Помилка при створенні звуків:', error);
    }
}

// Запускаємо генерацію
generateSounds();