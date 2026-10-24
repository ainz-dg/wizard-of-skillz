/**
 * Plain-text command hints. Keep navigation discoverable even when long lists
 * consume the screen; help contains no actions and cannot authorize Apply.
 */
export function commandHints(view,{
  narrow=false,searching=false,modelConfigured=false,providerPickerEnabled=false,
  editorConfigured=false,hasSemanticReport=false,applyConfigured=false,
  proposalCount=0,twoPane=false,wizardStep=null
}={}){
  if(wizardStep==='menu')
    return ['1 Copilot  2 Ollama locale  3 Ollama remoto',
      'ESC Annulla scelta'];
  if(wizardStep==='model')
    return ['INVIO Conferma modello  TAB Elenca modelli','ESC Annulla scelta'];
  if(wizardStep==='models')
    return ['↑↓ Naviga  INVIO Scegli modello  T Digita nome','ESC Torna'];
  if(wizardStep==='url')
    return ['Digita indirizzo  INVIO Conferma  BACKSPACE Cancella','ESC Annulla'];
  if(view==='help')
    return ['↑↓ Scorri  ESC / INVIO / ? Torna','Nessun comando dell’aiuto applica modifiche'];
  if(view==='overview')
    return narrow?[
      '↑↓ Scegli  INVIO Apri  ? Aiuto',
      'L Modello  K Audit  Q Esci'
    ]:[
      '↑↓ Scegli un’azione  INVIO Seleziona'+
        (hasSemanticReport?'  J Risultati':modelConfigured?'  K Audit':'')+
        (providerPickerEnabled?'  L Provider':''),
      '? Aiuto  Q Esci  ·  Solo G → Y può applicare le modifiche'
    ];
  if(view==='list'){
    if(searching)return [
      'Digita per cercare  INVIO Conferma  BACKSPACE Cancella',
      'ESC Annulla la ricerca'
    ];
    return !twoPane?[
      '↑↓ Proposta  INVIO Dettaglio  SPAZIO Seleziona',
      (applyConfigured?'G Lotto  ':'G DISABILITATO  ')+'M Proposta AI  ESC'
    ]:[
      'TAB Cambia pannello  ↑↓ Naviga/scorri  INVIO Dettaglio  P Diff',
      (modelConfigured?'M Proponi modifica (AI)  ':'')+
        (editorConfigured?'E Editor  ':'')+
        'SPAZIO Seleziona  '+(applyConfigured?'G Verifica lotto':'G Non applicabile')+
        '  F Filtro  / Cerca  ?'
    ];
  }
  if(view==='semantic-list')return narrow?[
    '↑↓ Scegli esito  INVIO Dettagli  ESC Menu',
    'Per la bozza: ESC → Esamina le proposte'
  ]:[
    '↑↓ Scegli esito  INVIO Leggi prove  ESC Torna al menu',
    'Per preparare una bozza: torna al menu → Esamina le proposte'
  ];
  if(view==='semantic-detail')return [
    '↑↓ Leggi testo e citazione  ESC Torna agli esiti',
    'Citazione autentica ≠ errore dimostrato  ·  ? Aiuto'
  ];
  if(view==='confirm-apply')return [
    'Y APPLICA TUTTO IL LOTTO   ESC ANNULLA SENZA SCRIVERE',
    '↑↓ Scorri i file coinvolti   Q Esci senza applicare'
  ];
  if(view==='diagnostics'||view==='diagnostic-detail')return [
    '↑↓ Naviga/scorri  INVIO Dettagli  ESC Torna  ? Aiuto',
    'Diagnosi soltanto: non applica modifiche'
  ];
  if(view==='detail')return [
    '↑↓ Leggi proposta completa  P Diff  ESC Elenco proposte',
    'M/E per preparare la patch dalla lista  ·  ? Aiuto'
  ];
  if(view==='preview')return [
    '↑↓ Leggi diff completo  V Dettaglio  ESC Elenco proposte',
    'G → Y solo dopo aver preparato e selezionato la patch'
  ];
  return [
    '↑↓ Scorri  ESC Torna  ? Aiuto',
    'Solo G → Y conferma una scrittura reale nel repository'
  ];
}

export const HELP_LINES=[
  'COME FUNZIONA',
  '1. SCANSIONE: il comando wizard scan controlla struttura e link senza modelli.',
  '2. ANALISI: L sceglie Copilot/Ollama; K invia le claim e gli snippet al modello.',
  '3. VERIFICA: J apre gli esiti; una citazione valida non dimostra un errore.',
  '4. PROPOSTA DI MODIFICA: M chiede all’AI un SKILL.md completo rivisto (solo UPDATE).',
  '   E permette una modifica con editor; P mostra il diff. Nessuna scrittura nel progetto.',
  '5. REVISIONE E DECISIONE: leggi tutto il diff, SPAZIO seleziona, G verifica il lotto;',
  '   solo Y, dopo conferma esplicita, scrive nel progetto.',
  '',
  'SCORCIATOIE AVANZATE',
  'H/C diagnosi separate · F filtro · / ricerca · X pulisci ricerca.',
  'A/N/I selezione · D/U scarta/ripristina · S salva sessione · R MOVE/REMOVE.',
  'Q esce · ESC torna indietro. Comandi disponibili solo nella vista pertinente.',
  'La selezione NON autorizza Apply: G → Y è sempre una decisione separata.'
];

export function contextualHelp(view){
  switch(view){
    case 'overview':
      return [
        'QUI: ↑↓ sceglie fra analizzare, esaminare le proposte e cambiare modello.',
        'INVIO attiva l’azione evidenziata; K, J e L restano scorciatoie.',
        'Non serve ricordare i tasti per utilizzare il Mago.'
      ];
    case 'list':
      return [
        'QUI: nella vista larga TAB cambia pannello; ↑↓ naviga o scorre le prove.',
        'M invia skill e prove all’AI e propone un nuovo SKILL.md completo (UPDATE).',
        'Leggi il diff: una proposta dell’AI non è una correzione verificata.',
        'SPAZIO seleziona una modifica revisionata; G verifica il lotto, Y applica.',
        'F filtra, / cerca, A seleziona tutte le visibili (non approva).'
      ];
    case 'semantic-list':
    case 'semantic-detail':
      return [
        'QUI: ↑↓ naviga le evidenze; INVIO espande; ESC torna.',
        'Una contraddizione sospetta è una proposta da verificare, non una prova.'
      ];
    case 'confirm-apply':
      return [
        'QUI: controlla i percorsi dei file coinvolti nel lotto.',
        'Solo Y applica davvero; ESC annulla senza cambiare il progetto.'
      ];
    default:
      return [
        'QUI: ↑↓ naviga o scorri i dettagli; ESC torna alla schermata precedente.',
        '? chiude questo aiuto. Nessun testo di aiuto modifica il repository.'
      ];
  }
}

/** Guarantee the last rows always contain currently actionable instructions. */
export function pinCommandHints(lines,hints,{height,width,fmt}){
  // Rendering exactly one terminal viewport keeps the footer at the bottom,
  // rather than immediately after short content (the previous implementation).
  const tail=[fmt('─'.repeat(width-2),'gray'),...hints.map(h=>fmt(h,'cyan'))];
  // Tiny viewports may hold fewer lines than the footer itself.
  // Keep the final actionable hints instead of overflowing the terminal.
  const visibleTail=tail.slice(-Math.max(1,height));
  const bodyHeight=Math.max(0,height-visibleTail.length);
  const body=lines.slice(0,bodyHeight);
  return [...body,...Array(bodyHeight-body.length).fill(''),...visibleTail].join('\n');
}
