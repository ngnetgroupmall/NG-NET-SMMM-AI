import * as XLSX from 'xlsx';
import type { AccountDetail, KebirAnalysisResult } from '../../common/types';



export const parseKebirFile = async (file: File): Promise<KebirAnalysisResult> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target?.result as ArrayBuffer);
                const workbook = XLSX.read(data, { type: 'array', cellDates: true });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

                if (rows.length < 2) { reject(new Error("Dosya boş.")); return; }

                const norm = (s: any) => String(s).replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase().trim();

                let hdrIdx = -1;
                let cols: Record<string, number> = {};
                let dateMethod = "None";

                // Find header row
                for (let i = 0; i < Math.min(50, rows.length); i++) {
                    const r = rows[i];
                    if (!r) continue;
                    const nr = r.map(norm);

                    const codeIdx = nr.findIndex(c => c === 'hesap kodu' || c.includes('hesap kodu'));
                    const debitIdx = nr.findIndex(c => c.includes('borç') || c.includes('borc'));

                    if (codeIdx >= 0 && debitIdx >= 0) {
                        hdrIdx = i;

                        nr.forEach((cell, idx) => {
                            if (cell.includes('tarih') && cols['date'] === undefined) cols['date'] = idx;
                            if ((cell === 'hesap kodu' || cell.includes('hesap kodu')) && cols['code'] === undefined) cols['code'] = idx;
                            if ((cell.includes('hesap adı') || cell === 'açıklama' || cell === 'aciklama') && cols['name'] === undefined) cols['name'] = idx;
                            if ((cell.includes('borç') || cell.includes('borc')) && cols['debit'] === undefined) cols['debit'] = idx;
                            if (cell.includes('alacak') && cols['credit'] === undefined) cols['credit'] = idx;
                            if ((cell.includes('fiş') || cell.includes('fis') || cell.includes('belge') || cell.includes('makbuz')) && cell.includes('no') && cols['voucher'] === undefined) {
                                cols['voucher'] = idx;
                            }
                            if (cell.includes('açıklama') || cell.includes('aciklama')) {
                                cols['desc'] = idx;
                            }
                        });

                        if (cols['name'] === undefined && cols['desc'] !== undefined) {
                            cols['name'] = cols['desc'];
                        }
                        break;
                    }
                }

                if (hdrIdx === -1 || cols['code'] === undefined) {
                    reject(new Error("Başlık tespit edilemedi."));
                    return;
                }

                // Fallback: Statistical date detection
                if (cols['date'] === undefined) {
                    const scores: Record<number, number> = {};
                    for (let r = hdrIdx + 1; r < Math.min(rows.length, hdrIdx + 100); r++) {
                        const row = rows[r];
                        if (!row) continue;
                        row.forEach((val, c) => {
                            if (!val) return;
                            let ok = false;
                            if (val instanceof Date && !isNaN(val.getTime())) ok = true;
                            else {
                                const s = String(val).trim();
                                if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(s)) ok = true;
                            }
                            if (ok) scores[c] = (scores[c] || 0) + 1;
                        });
                    }
                    let best = -1, max = 0;
                    Object.entries(scores).forEach(([c, s]) => { if (s > max) { max = s; best = +c; } });
                    if (best >= 0 && max >= 5) { cols['date'] = best; dateMethod = `Stat(${best},${max})`; }
                }

                // Process Data
                let total = 0, tDebit = 0, tCredit = 0;
                // Enhanced monthly tracking
                const monthly = Array(12).fill(0).map((_, i) => ({
                    month: i + 1,
                    count: 0,
                    volume: 0,
                    uniqueAccounts: new Set<string>(),
                    uniqueVouchers: new Set<string>()
                }));

                const accountMap = new Map<string, AccountDetail>();
                const uniqueVouchers = new Set<string>();
                const keys: Record<string, { count: number; volume: number }> = {
                    '102': { count: 0, volume: 0 }, '191': { count: 0, volume: 0 },
                    '391': { count: 0, volume: 0 }, '601': { count: 0, volume: 0 }
                };

                const sampleDates: string[] = [];
                let parsedDateCount = 0;

                for (let i = hdrIdx + 1; i < rows.length; i++) {
                    const row = rows[i];
                    if (!row) continue;
                    const code = String(row[cols['code']] || '').trim();
                    if (!code || code.length < 3 || code.toLowerCase().includes('toplam')) continue;

                    let vNo = '';
                    if (cols['voucher'] !== undefined) {
                        vNo = String(row[cols['voucher']] || '').trim();
                        if (vNo.length > 1) uniqueVouchers.add(vNo);
                    }

                    const d = parseFloat(String(row[cols['debit']] || '0').replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0;
                    const c = parseFloat(String(row[cols['credit']] || '0').replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0;
                    const vol = d + c;
                    total++; tDebit += d; tCredit += c;

                    // Date Parsing
                    let rowDate: Date | null = null;
                    if (cols['date'] !== undefined) {
                        const v = row[cols['date']];
                        let m = -1;
                        if (sampleDates.length < 5 && v) sampleDates.push(String(v));

                        if (v instanceof Date && !isNaN(v.getTime())) {
                            // TIMEZONE FIX: cellDates:true returns UTC midnight; getMonth() gives
                            // the previous day in UTC+ zones. Use UTC components to rebuild local date.
                            m = v.getUTCMonth();
                            rowDate = new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate(), 12, 0, 0, 0);
                        } else if (v) {
                            const s = String(v).trim();
                            const dm = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
                            if (dm) {
                                m = parseInt(dm[2]) - 1;
                                rowDate = new Date(parseInt(dm[3]), m, parseInt(dm[1]), 12, 0, 0, 0);
                            } else {
                                const ymd = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
                                if (ymd) {
                                    m = parseInt(ymd[2]) - 1;
                                    rowDate = new Date(parseInt(ymd[1]), m, parseInt(ymd[3]), 12, 0, 0, 0);
                                }
                            }
                        }

                        if (m >= 0 && m < 12) {
                            monthly[m].count++;
                            monthly[m].volume += vol;
                            monthly[m].uniqueAccounts.add(code);
                            if (vNo.length > 1) monthly[m].uniqueVouchers.add(vNo);
                            parsedDateCount++;
                        }
                    }

                    // Account Stats (Mizan)
                    const name = cols['name'] !== undefined ? String(row[cols['name']] || '') : '';
                    const desc = cols['desc'] !== undefined ? String(row[cols['desc']] || name) : name;

                    if (!accountMap.has(code)) {
                        accountMap.set(code, {
                            code,
                            name,
                            totalDebit: 0,
                            totalCredit: 0,
                            balance: 0,
                            transactionCount: 0,
                            transactions: []
                        });
                    }

                    const acc = accountMap.get(code)!;
                    acc.totalDebit += d;
                    acc.totalCredit += c;
                    acc.balance = acc.totalDebit - acc.totalCredit;
                    acc.transactionCount++;
                    if (name.length > acc.name.length) acc.name = name;

                    acc.transactions.push({
                        date: rowDate,
                        description: desc,
                        debit: d,
                        credit: c,
                        voucherNo: vNo
                    });

                    const main = code.substring(0, 3);
                    if (keys[main]) { keys[main].count++; keys[main].volume += vol; }
                }

                // Calculate Monthly Averages
                const activeMonths = monthly.filter(m => m.count > 0);
                const avgUniqueAcc = activeMonths.length > 0
                    ? Math.round(activeMonths.reduce((acc, m) => acc + m.uniqueAccounts.size, 0) / activeMonths.length)
                    : 0;
                const avgUniqueVoucher = activeMonths.length > 0
                    ? Math.round(activeMonths.reduce((acc, m) => acc + m.uniqueVouchers.size, 0) / activeMonths.length)
                    : 0;

                // Post-process Mizan
                const mizan = Array.from(accountMap.values()).map(acc => {
                    acc.transactions.sort((a, b) => {
                        if (!a.date) return 1;
                        if (!b.date) return -1;
                        return a.date.getTime() - b.date.getTime();
                    });
                    acc.totalDebit = Math.round(acc.totalDebit * 100) / 100;
                    acc.totalCredit = Math.round(acc.totalCredit * 100) / 100;
                    acc.balance = Math.round(acc.balance * 100) / 100;
                    return acc;
                }).sort((a, b) => a.code.localeCompare(b.code));

                // Top Accounts (Main)
                const mainMap = new Map<string, { name: string, count: number, volume: number }>();
                mizan.forEach(acc => {
                    const main = acc.code.substring(0, 3);
                    if (!mainMap.has(main)) mainMap.set(main, { name: acc.name, count: 0, volume: 0 });
                    const m = mainMap.get(main)!;
                    m.count += acc.transactionCount;
                    m.volume += (acc.totalDebit + acc.totalCredit);
                    // Use shortest name to try to catch Main Account name
                    // Usually main account name is like 'BANKALAR' (very short)
                    // Sub accounts are 'BANKALAR > X Bankası'
                    if (!m.name || (acc.name && acc.name.length < m.name.length)) m.name = acc.name;
                });

                const top = Array.from(mainMap.entries())
                    .map(([code, v]) => ({ code, name: v.name, count: v.count, volume: v.volume }))
                    .sort((a, b) => b.count - a.count).slice(0, 50);

                let score = (total / 500) + (uniqueVouchers.size / 20); if (score > 10) score = 10;

                resolve({
                    totalLines: total,
                    uniqueAccountCount: accountMap.size,
                    uniqueVoucherCount: uniqueVouchers.size,
                    monthlyDensity: monthly.map(m => ({ month: m.month, count: m.count, volume: m.volume })), // clean for return
                    topAccounts: top,
                    mizan,
                    totalDebit: tDebit,
                    totalCredit: tCredit,
                    complexityScore: Math.round(score * 10) / 10,
                    keyAccounts: keys,
                    avgUniqueAccounts: avgUniqueAcc,
                    avgUniqueVouchers: avgUniqueVoucher,
                    debugMeta: {
                        headerRowIndex: hdrIdx,
                        detectedColumns: cols,
                        successRate: `${total} satır`,
                        fileName: file.name,
                        dateMethod,
                        sampleDates: sampleDates.slice(0, 5),
                        parsedDateCount
                    }
                });
            } catch (err) { reject(err); }
        };
        reader.onerror = (err) => reject(err);
        reader.readAsArrayBuffer(file);
    });
};
