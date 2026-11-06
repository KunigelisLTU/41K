# Battle tracker – funkcijų medis (orientyras Play režimui)

Sudaryta statiškai peržiūrėjus *Tabletop Battles* 1.41.2 (Goonhammer, Flutter) APK struktūrą:
modulių pavadinimus ir UI tekstus. Tai tik funkcijų sąrašas mūsų pačių dizainui – jokio jų kodo,
duomenų ar misijų tekstų neperimame.

Žymėjimas: **[11e]** – 11-os redakcijos specifika, **[mums]** – ką tikslinga daryti mūsų Play režime,
**[ne]** – už mūsų apimties ribų.

```
Tabletop Battles
├── Pagrindinis (Home / Dashboard)
│   ├── Paskutinis žaidimas (tęsti)
│   ├── Win rate per laiką (grafikas)
│   └── Naujienos / video / akcijos (RSS, YouTube)                [ne]
│
├── Žaidimų sąrašas
│   ├── Žaidimo kortelė (frakcijos, misija, rezultatas, data)
│   ├── Paieška ir filtrai
│   ├── Renginiai (event): kelių žaidimų grupė, renginio presetai  [mums: vėliau]
│   └── Naujas žaidimas (FAB) → žaidimo sistemos pasirinkimas
│       (40k 9e/10e/11e, Combat Patrol, Boarding Actions, Kill Team, AoS, HH, Old World, ...)
│
├── Žaidimas (Game detail) – vedlys puslapiais su apatine navigacija / „jump list“
│   ├── 1. Setup
│   │   ├── Data, renginys, mission pack pasirinkimas
│   │   ├── Scoring metrika (kaip skaičiuojamas rezultatas)
│   │   └── Jungikliai (pvz. Fixed vs Tactical secondaries)
│   ├── 2. Žaidėjai (abu)
│   │   ├── Vardas, frakcija (su ikonėle), subfrakcija/detachment
│   │   ├── Force Disposition                                     [11e][mums]
│   │   ├── Armijos sąrašas: įklijuoti / importuoti (BattleForge, BCP) ir peržiūrėti  [mums: iš mūsų rosterių]
│   │   └── Papildomi laukai (checkbox'ai, slankikliai, tekstas)
│   ├── 3. Misija
│   │   ├── Primary Mission – nustatoma pagal abiejų Force Disposition   [11e][mums]
│   │   ├── Mission Rule (twist) korta                             [11e]
│   │   ├── Deployment žemėlapis + terrain layout (vizualus)        [mums: tik pavadinimas]
│   │   └── Presetai (renginių paketai)
│   ├── 4. Prieš žaidimą
│   │   ├── Attacker / Defender nustatymas (roll-off mygtukas)
│   │   ├── Kas eina pirmas
│   │   ├── Pre-game klausimai (pvz. ar yra unitų, didinančių priešo stratagemų CP kainą)
│   │   ├── Strategic Footing, Scouting                            [11e]
│   │   └── Secondary būdas: Fixed (pasirenkamos 2) arba Tactical (kaladė)
│   ├── 5. Raundai (Battle Round 1–5), kiekvienam – abiejų žaidėjų kortelės
│   │   ├── Primary VP: score part'ai (checkbox / stepper / radio / tekstas),
│   │   │   taisyklė „kada skaičiuojama“ (Command fazėje, ėjimo pabaigoje, ...)
│   │   ├── Secondary VP
│   │   │   ├── Tactical: traukti korteles, atmesti (Discard), New Orders (už CP),
│   │   │   │   pakeisti, kai korta netinkama; atmesta pradžioje / pabaigoje
│   │   │   └── Fixed: dvi kortos visam žaidimui, max VP vienai kortai,
│   │   │       vienkartinis pakeitimas į kitą Fixed
│   │   ├── CP: gauta / išleista / likutis per raundą
│   │   ├── Frakcijų trackeriai (pvz. Waaagh, Combat Doctrines, Blood Tithe,
│   │   │   Pain tokens, Battle Focus) – skaitikliai, jungikliai, „aktyvi taisyklė šį raundą“
│   │   ├── Taisyklių tekstas (info mygtukas prie kiekvieno scoring elemento)
│   │   └── Taškų suvestinė (scoreboard preview, raundų × žaidėjų lentelė)
│   ├── 6. Secret Mission (po 3 raundo, jei atsiliekama Primary VP)   [11e]
│   ├── 7. Mūšio pabaiga
│   │   ├── End-of-battle scoring
│   │   ├── Pasidavimas (concede) / laimėtojas
│   │   └── Galutinis rezultatas (+ VP skirtumas)
│   ├── Nuotraukos prie žaidimo                                    [ne]
│   ├── Žaidimo žurnalas (game log) – kas ir kada pakeista          [mums]
│   └── Bendrinimas
│       ├── Observer kodas / QR – kitas įrenginys stebi gyvai       [ne / vėliau]
│       ├── Susietas žaidimas (linked game, abu žaidėjai savo telefone, WebSocket)
│       └── Rezultato pateikimas į BCP (turnyrai)                    [ne]
│
├── Statistika
│   ├── Win rate, vidutinis VP, „loss differential“
│   └── Filtrai (frakcija, laikotarpis, sistema)                    [mums: vėliau]
│
└── Nustatymai
    ├── Paskyra (Cognito), sinchronizacija debesyje               [mums: jau turim Gist sync]
    ├── Žaidimo numatytosios reikšmės (defaults)
    ├── Išvaizda, kalba, frakcijų ikonėlės
    └── Unlock kodai / prenumerata                                  [ne]
```

## Ko ten nėra (ir kur galime būti geresni)

- **Stratagemų sekimo nėra.** CP yra tik kaip skaičiai (gauta / išleista / likutis). Neseka, kuri stratagema
  panaudota, ir netikrina apribojimų („once per phase / turn / battle“, ta pati stratagema dukart toje pačioje
  fazėje, 1 raunde draudžiamos Core stratagemos išskyrus New Orders ir pan.).
  Mes turim stratagemas su CP ir fazėmis – čia mūsų pagrindinis privalumas.
- **Fazių eigos nėra** – sekama raundais, ne Command → Movement → Shooting → Charge → Fight.
  Mes galime rodyti tik tos fazės / ėjimo stratagemas (filtrai jau yra).
- **Šachmatų laikrodžio nėra** (likęs tik seno formato laukas).

> **Atnaujinta:** Play taisyklės dabar remiasi oficialiomis 11th Edition Core Rules ir Warhammer Event Companion
> (žr. README → Play). Žemiau esanti lentelė – pirminė APK analizė; jos skaičiai (50 / 40 VP, max 2 Tactical
> kortos) pakeisti pagal Event Companion: 45 / 45 VP, po 15 VP per battle round, Command fazėje traukiamos dvi
> kortos, New Orders – once per battle.

## Validacijos taisyklės (iš APK tekstų) → mūsų Play režime (pirminė versija)

| Taisyklė APK tekstuose | Mūsų įgyvendinimas (`play.js`) |
|---|---|
| CP: gauta / išleista / likutis, „Starting CP“ | `startCp` + Command fazės + extra − išleista |
| Discard Tactical kortos ėjimo pabaigoje → 1CP | Discard savo ėjime: +1CP (jei neviršyta extra CP riba) |
| Ne daugiau kaip 2 aktyvios Tactical kortos, papildyti Command fazėje | Draw blokuojamas, kai yra 2; Command fazėje primenama |
| New Orders (End of your Command phase) | Core sąraše, galioja tik tavo Command fazėje |
| Max 100VP: 50 Primary (+Secret), 40 Secondary, 10 Battle Ready; perteklius prarandamas | Ribos konfigūruojamos, perteklius nukerpamas ir parašoma, kiek prarasta |
| Fixed Mission kortai max 20VP | `fixedCardCap` |
| Primary „up to 10/15VP per turn“ (misijos) | `primaryTurnCap`, numatyta išjungta |
| 1 raunde draudžiamos Core stratagemos išskyrus New Orders (mission rule) | `round1NoCore`, numatyta išjungta |
| Klausimas „ar yra unitų, didinančių stratagemų CP kainą?“ | Žaidėjo nustatymas „Stratagem cost +CP“ |

Papildomai (APK to nedaro): stratagemos laikas pagal ėjimą ir fazę, ta pati stratagema kartą per fazę,
„once per battle / round / turn“ iš stratagemos teksto, extra CP riba per raundą.

## Duomenų modelis (pagal laukus, matytus APK)

- Žaidimas: id, data, sistema, mission pack, misija, deployment, kas pirmas, attacker/defender,
  baigtas / užrakintas, versija, sukurta / atnaujinta.
- Žaidėjas: vardas, frakcija, pastabos, Force Disposition, armijos sąrašas,
  primaries[raundas] (score part'ai), secondaries[] (id, taškai, pastabos, atmesta / pakeista),
  cp[raundas] (gauta, išleista, likutis), trackerių būsena per raundą, pasidavė.
- Score part: id, pavadinimas, kada skaičiuojama, UI tipas (checkbox / stepper / radio / tekstas),
  taškai, max per raundą / per žaidimą.
