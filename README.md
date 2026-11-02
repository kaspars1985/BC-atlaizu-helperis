# BC atlaižu pārvaldnieks

<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="BC atlaižu pārvaldnieks Logo" /><br>
  <a href="https://github.com/kaspars1985/BC-atlaizu-helperis/releases/latest"><img src="https://img.shields.io/github/v/release/kaspars1985/BC-atlaizu-helperis?label=Laidiens&color=ff5501" alt="Latest Release"></a>
  <a href="https://github.com/kaspars1985/BC-atlaizu-helperis/releases/latest"><img src="https://img.shields.io/badge/Lejupielādēt-.zip-blue?style=flat&logo=github" alt="Download ZIP"></a>
</p>

Pārlūka paplašinājums darbam ar Microsoft Dynamics 365 Business Central.

---

## Kam tas domāts

Kad pasūtījumu formē uz vienu firmu (piemēram, būvfirmu), bet preces pērk meistars, kurš norādīts laukā "Saistītā klienta nr.", Business Central pats neieliek meistara atlaides, jo skatās tikai rēķina saņēmēja nosacījumus.

Lai katrai rindai nebūtu manuāli jāmeklē meistara līguma atlaides un ar roku jāpārraksta procenti, šis paplašinājums atrod atbilstošās atlaides un ieraksta tās visās pasūtījuma rindās tieši caur Business Central OData servisu.

---

## Uzstādīšana

> **Ieteicamā vieta:** izpako paplašinājumu stabilā mapē, piemēram
> `%LOCALAPPDATA%\BC-atlaizu-helperis` (ielīmē šo ceļu Explorer adreses joslā).
> Tad turpmākie atjauninājumi notiek automātiski un nesaplīst ar citām mapēm.

### Microsoft Edge:
1. Adreses joslā atver: `edge://extensions`
2. Kreisajā pusē ieslēdz "Developer mode" (Izstrādātāja režīms).
3. Nospied pogu "Load unpacked" (Ielādēt neiepakotu).
4. Izvēlies šī paplašinājuma mapi (vai atpakoto zip arhīvu).
5. Pie puzles ikonas rīkjoslā nospied acs ikonu pie "BC atlaižu pārvaldnieks", lai ikona būtu redzama pārlūka joslā.

### Google Chrome:
1. Adreses joslā atver: `chrome://extensions`
2. Augšējā labajā stūrī ieslēdz "Developer mode".
3. Nospied "Load unpacked" un norādi paplašinājuma mapi.

---

## Atjaunināšana (bez ZIP lejupielādes)

Paplašinājums ir uzstādīts kā "unpacked", tāpēc pārlūks pats to nelejupielādē —
atjauninājumu piegādā mazais skripts mapē `atjauninasana/`.

**Kā tas strādā:**
1. `atjauninasana/update.ps1` paņem jaunāko GitHub laidienu un izpako to virsū
   paplašinājuma mapei (vecie faili tiek aizvietoti, novecojušie izņemti).
2. Paplašinājums pats pamana, ka diskā ir jaunāka versija (`manifest.json` versija
   lielāka par darbojošos), un atlaižu logā parāda zaļu baneri ar pogu
   **"↻ Pārlādēt tagad"**. Uz rīkjoslas ikonas parādās `↻` zīme.
3. Poga pārlādē Business Central cilni un paplašinājumu. Pasūtījums paliek serverī,
   dati netiek pazaudēti.

**Pirmā uzstādīšana (vienreiz):**
1. Izpako jaunāko `.zip` mapē `%LOCALAPPDATA%\BC-atlaizu-helperis`.
2. `edge://extensions` → Developer mode → Load unpacked → izvēlies šo mapi.
3. Atver mapi `atjauninasana` un palaid **`Ieslegt-AutoAtjauninasanu.cmd`** —
   tā reģistrē pārbaudi katrā Windows pieslēgšanās reizē (HKCU `Run` atslēga,
   admin tiesības nav vajadzīgas).

**Ikdienā:** nekas nav jādara. Ja gribi pārbaudīt uzreiz — palaid
`atjauninasana\Atjauninat-tagad.cmd`. Izslēgt — `Atcelt-AutoAtjauninasanu.cmd`.
Žurnāls: `atjauninasana\update.log`.

**Izlaides sagatavošana (izstrādātājam):** veidojot jaunu laidienu, iekļauj `.zip`
arī mapi `atjauninasana/` un pirms tam `manifest.json` un `content.js`
(`APP_VERSION`) paceļ versiju. Pretējā gadījumā kolēģiem pazudīs atjauninātājs.

---

## Kā lietot

1. **Atver pasūtījumu**  
   Business Central atver pārdošanas pasūtījumu, kurā ir aizpildīts lauks "Saistītā klienta nr.". Pašā BC ekrānā nekādu lieku pogu nav.

2. **Atver atlaižu logu**  
   Nospied tastatūras saīsni `Alt+D` vai uzklikšķini uz paplašinājuma ikonas pārlūka augšējā joslā.

3. **Klienta atlaižu ielasīšana (tikai pirmajā reizē)**  
   Ja konkrētajam saistītajam klientam atlaides vēl nav nolasītas, atvērtajā logā nospied pogu, lai tās ielasītu no 7004. lapas. Tas aizņem pāris sekundes, un dati saglabājas pārlūka atmiņā turpmākam darbam.

4. **Pārbaudi un ieraksti**  
   Pārskati sagatavoto rindu sarakstu. Ja nepieciešams, kādai rindai procentu vari palabot ar roku. Pēc tam nospied "Automātiski ierakstīt".

5. **Autorizācija un pārrēķins**  
   Pirmajā reizē paplašinājums palūgs ievadīt tavu BC lietotājvārdu (`DOMĒNS\lietotājs`) un paroli, lai varētu caur OData servisu (`:7048`) ierakstīt atlaides visām rindām vienlaicīgi. Pēc ierakstīšanas nospied `F5`, lai Business Central pārrēķina pasūtījuma summas.
