export const normalizeString = (str: string | any): string => {
    if (typeof str !== 'string') return '';
    return str.trim().replace(/\s+/g, ' ').toUpperCase();
};

export const parseTurkishNumber = (val: any): number => {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    let str = String(val).trim().replace(/\s/g, '');

    // Heuristic: If there is a comma, it's Turkish format (1.234,56 or 180,00)
    // If no comma but there is a dot, it might be standard decimal (180.00) 
    // or Turkish thousands (1.000). 
    // In e-invoice/accounting data, dots are more commonly decimals if no comma exists.
    if (str.includes(',')) {
        str = str.replace(/\./g, '').replace(/,/g, '.');
    }

    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
};

// Regex: 3 chars (AlphaNumeric) + 4 year + 9 digits = 16 characters
// Rules: 
// 1. Total 16 characters
// 2. First 3 can be letters or numbers
// 3. Characters 4-7 are the year
// 4. Remaining are digits
export const INVOICE_NO_REGEX = /[A-Z0-9]{3}\d{4}\d{9}/g;

export const extractInvoiceNo = (text: string): { matches: string[], first: string | null } => {
    if (!text) return { matches: [], first: null };

    // Normalize text: remove dots, spaces, and convert to uppercase
    const normalized = text.toUpperCase().replace(/\./g, '').replace(/\s+/g, '');
    const matches = normalized.match(INVOICE_NO_REGEX) || [];

    return {
        matches: [...new Set(matches)],
        first: matches[0] || null
    };
};

export const normalizeVKN = (val: any): string | null => {
    if (!val) return null;
    const str = String(val).replace(/\D/g, ''); // Remove non-digits
    // VKN is usually 10 digits, TCKN is 11. 
    // We strictly check for length to avoid garbage matches
    if (str.length === 10 || str.length === 11) return str;
    return null;
};

export const formatDate = (date: Date | null): string => {
    if (!date) return '-';
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
};
