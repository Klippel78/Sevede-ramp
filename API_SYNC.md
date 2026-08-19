# Sevede API-synk

Kör en manuell, skrivskyddad uppdatering från projektroten:

```bash
python3 scripts/sync-sevede-data.py
```

Synken läser Sevede System-varianter från Litium och verifierar de två standardtillbehören mot Monitor med exakt ID-/artikelmatchning. Inloggning hämtas lokalt från macOS Keychain. Inga nycklar, tokens, sessioner eller fullständiga ERP-rader skrivs till webbappen.

En komplett körning ersätter atomiskt:

- `data/sevede-current.json` för maskinläsbar kontroll.
- `data/sevede-current.js` för konfiguratorn, inklusive lokal `file://`-visning.

Täckningsgrinden kräver tre systemprodukter, 84 PIM-varianter och två ERP-verifierade tillbehör. Vid fel behålls den senast accepterade cachen. Litiums avrundade längder skriver inte över konfiguratorns decimalprecisa mått utan separat granskning.

Synken är inte schemalagd och publicerar inte automatiskt till GitHub eller Vercel.
