import { parseH02Frame } from '../src/protocol-gateway/adapters/h02.parser';

/** Tramas de prueba: ejemplo clásico H02 + coordenadas de Cartagena (W). */
const cases: Array<[string, string]> = [
  ['V1 ejemplo clásico H02',
   '*HQ,4210209006,V1,050316,A,2212.8745,N,11346.6574,E,14.28,028,220902,FFFFFBFF#'],
  ['V1 Cartagena (hemisferio W)',
   '*HQ,9170001234,V1,153000,A,1023.9832,N,07530.8666,W,12.50,090,230726,FFFFFBFF#'],
  ['Heartbeat con batería',
   '*HQ,9170001234,HTBT,93#'],
  ['V1 sin fix GPS (flag V)',
   '*HQ,9170001234,V1,153000,V,0000.0000,N,00000.0000,W,0.00,000,230726,FFFFFBFF#'],
  ['Trama con extras LBS al final',
   '*HQ,9170001234,V1,153010,A,1023.9832,N,07530.8666,W,0.00,000,230726,FFFFFBFF,732,101,1A2B,3C4D#'],
  ['Basura (debe dar null)', 'hola mundo'],
];

let failed = 0;
for (const [name, frame] of cases) {
  console.log(`\n== ${name} ==`);
  try {
    const result = parseH02Frame(frame);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    failed++;
    console.error('EXCEPCIÓN:', (err as Error).message);
  }
}
process.exit(failed === 0 ? 0 : 1);
