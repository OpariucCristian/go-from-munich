/** Europe/Berlin calendar helpers for URL state. */
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });

export const berlinToday = () => ymd.format(new Date());
export const berlinDateOf = (iso: string) => ymd.format(new Date(iso));
const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const berlinNowHm = () => hm.format(new Date());
