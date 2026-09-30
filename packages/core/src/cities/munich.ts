import type { CityConfig } from '../cityConfig.ts';

export const munich: CityConfig = {
  id: 'muc',
  name: 'München',
  tz: 'Europe/Berlin',
  hubs: [
    { eva: '8000261', name: 'München Hbf' },
    // Holding tracks 27-36 (Starnberger Flügelbahnhof): most regional/RE departures are reported here.
    { eva: '8098261', name: 'München Hbf Gl.27-36' },
    { eva: '8000262', name: 'München Ost' },
    { eva: '8004158', name: 'München-Pasing' },
  ],
  // RE/RB-type services in Bavaria are largely run by private operators (BRB, ARV = Arverio, ALX = alex).
  trainTypes: ['ICE', 'IC', 'EC', 'ECE', 'RJ', 'RJX', 'NJ', 'EN', 'TGV', 'RE', 'RB', 'BRB', 'ARV', 'ALX'],
  corridor: [
    { eva: '8000013', name: 'Augsburg Hbf' },
    { eva: '8000284', name: 'Nürnberg Hbf' },
    { eva: '8000183', name: 'Ingolstadt Hbf' },
    { eva: '8000320', name: 'Rosenheim' },
    { eva: '8000309', name: 'Regensburg Hbf' },
    { eva: '8000217', name: 'Landshut (Bay) Hbf' },
    { eva: '8000170', name: 'Ulm Hbf' },
  ],
  // Seen before they reach the corridor: Rosenheim traffic from Austria, Augsburg/Nürnberg
  // traffic from Stuttgart and Würzburg, ICEs from Erfurt (Berlin line) and Mannheim (Rhine line)
  // before Nürnberg and Stuttgart/Ulm. EVAs from the IRIS station lookup.
  upstream: [
    { eva: '8100002', name: 'Salzburg Hbf' },
    { eva: '8100001', name: 'Kufstein' },
    { eva: '8000096', name: 'Stuttgart Hbf' },
    { eva: '8000260', name: 'Würzburg Hbf' },
    { eva: '8010101', name: 'Erfurt Hbf' },
    { eva: '8000244', name: 'Mannheim Hbf' },
  ],
  // The city plus the main lines' approaches, for local and "worst along the way" weather.
  weatherPoints: [
    { id: 'muc', lat: 48.1402, lon: 11.5586 },
    { id: 'aug', lat: 48.3655, lon: 10.8856 },
    { id: 'nue', lat: 49.4456, lon: 11.0825 },
    { id: 'ing', lat: 48.7445, lon: 11.4372 },
    { id: 'rgb', lat: 49.0117, lon: 12.0996 },
    { id: 'ros', lat: 47.85, lon: 12.119 },
    { id: 'sbg', lat: 47.813, lon: 13.0456 },
    { id: 'ulm', lat: 48.3994, lon: 9.9829 },
  ],
  minTransferMin: 6,
};
