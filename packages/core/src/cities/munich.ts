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
  minTransferMin: 6,
};
