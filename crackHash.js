import crypto from 'crypto';

class PINDecryptor {
    constructor() {
        this.keyComponents = 3;
        this.maxKcvDigits = 6;
    }

    // Utility method to check if character is printable
    static isPrintableChar(charCode) {
        return (charCode >= 48 && charCode <= 57);  // 0-9
    }

    // Advanced key generation with multiple strategies
    generateKey(components) {
        // Strategy 1: Simple concatenation
        const method1 = components.join('').padEnd(16, '0').slice(0, 16);
        
        // Strategy 2: Interleave characters
        const method2 = this.interleaveKey(components);
        
        // Strategy 3: Hash-based key derivation
        const method3 = this.hashKey(components);

        return [
            Buffer.from(method1, 'utf8'),
            Buffer.from(method2, 'utf8'),
            Buffer.from(method3, 'utf8')
        ];
    }

    // Interleave characters from key components
    interleaveKey(components) {
        const maxLength = Math.max(...components.map(c => c.length));
        let result = '';
        for (let i = 0; i < maxLength; i++) {
            for (const comp of components) {
                if (i < comp.length) {
                    result += comp[i];
                }
            }
        }
        return result.padEnd(16, '0').slice(0, 16);
    }

    // Hash-based key derivation
    hashKey(components) {
        const combinedKey = components.join('');
        const hash = crypto.createHash('sha256');
        hash.update(combinedKey);
        return hash.digest('hex').slice(0, 16);
    }

    // Custom decryption strategies
    decryptPinCustom(encryptedHex) {
        const strategies = [
            this.decryptSimpleOffset.bind(this),
            this.decryptXOR.bind(this),
            this.decryptBitShift.bind(this)
        ];

        for (const strategy of strategies) {
            const result = strategy(encryptedHex);
            if (result) return result;
        }

        return null;
    }

    // Simple offset decryption
    decryptSimpleOffset(encryptedHex) {
        const buffer = Buffer.from(encryptedHex, 'hex');
        const result = buffer.map(byte => {
            // Try various offset strategies
            const offsets = [1, -1, 2, -2];
            for (const offset of offsets) {
                const decoded = byte - offset;
                if (PINDecryptor.isPrintableChar(decoded)) {
                    return decoded;
                }
            }
            return byte;
        });

        const decoded = result.toString('utf8').replace(/[^0-9]/g, '');
        return decoded.slice(0, this.maxKcvDigits) || null;
    }

    // XOR-based decryption
    decryptXOR(encryptedHex) {
        const buffer = Buffer.from(encryptedHex, 'hex');
        const xorKeys = [
            0x0F, 0xF0, 0x55, 0xAA,  // Common XOR patterns
            parseInt(encryptedHex.slice(0, 2), 16)  // First byte
        ];

        for (const key of xorKeys) {
            const result = buffer.map(byte => byte ^ key);
            const decoded = Buffer.from(result).toString('utf8')
                .replace(/[^0-9]/g, '');
            
            const trimmedPin = decoded.slice(0, this.maxKcvDigits);
            if (trimmedPin) return trimmedPin;
        }

        return null;
    }

    // Bit shift decryption
    decryptBitShift(encryptedHex) {
        const buffer = Buffer.from(encryptedHex, 'hex');
        const shifts = [1, 2, 4, 8];

        for (const shift of shifts) {
            const leftShift = buffer.map(byte => (byte << shift) & 0xFF);
            const rightShift = buffer.map(byte => (byte >> shift) & 0xFF);

            const strategies = [leftShift, rightShift];
            for (const strategy of strategies) {
                const result = Buffer.from(strategy);
                const decoded = result.toString('utf8')
                    .replace(/[^0-9]/g, '');
                
                const trimmedPin = decoded.slice(0, this.maxKcvDigits);
                if (trimmedPin) return trimmedPin;
            }
        }

        return null;
    }

    // Main decryption method
    decryptPin(encryptedHex) {
        return this.decryptPinCustom(encryptedHex);
    }
}

// Main execution function
async function main() {
    const decryptor = new PINDecryptor();

    // Sample encrypted PINs from database
    const encryptedPins = {
        'TBetemariam': '5a5b440e',
        'REBECCAAK': '5e59470b',
        'henokt': '5d58470f',
        'MELATESH': '5f5f410e',
        'LELIAS': '5e584708',
        'MIRAFALE': '5e5a470a',
        'TEDLABAY': '595f410a'
    };

    console.log("PIN Decryption Attempts:");
    for (const [username, encryptedPin] of Object.entries(encryptedPins)) {
        const decryptedPin = decryptor.decryptPin(encryptedPin);
        console.log(`${username}: ${encryptedPin} -> ${decryptedPin}`);
    }
}

// Run the decryption
main().catch(console.error);