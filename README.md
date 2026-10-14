# BC Atlaižu Helperis

<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="BC Atlaižu Helperis Logo" /><br>
  <a href="https://github.com/kaspars1985/BC-atlaizu-helperis/releases/latest"><img src="https://img.shields.io/github/v/release/kaspars1985/BC-atlaizu-helperis?label=Laidiens&color=ff5501" alt="Latest Release"></a>
  <a href="https://github.com/kaspars1985/BC-atlaizu-helperis/releases/download/v1.3.6/BC-atlaizu-helperis.zip"><img src="https://img.shields.io/badge/Lejupielādēt-.zip-blue?style=flat&logo=github" alt="Download ZIP"></a>
</p>

Vieds un ērts **Microsoft Edge** un **Google Chrome** pārlūka paplašinājums AM Furnitūra darbiniekiem: saistītā klienta rindu atlaižu automātiska nolasīšana un zibenīga piemērošana **Microsoft Dynamics 365 Business Central**.

---

## 🚀 Kā tas atvieglo ikdienas darbu?

Bieži rodas situācija: klients (piemēram, meistars ar kodu `011420`) pasūta preces, bet rēķins un pasūtījums tiek noformēts uz citas firmas rekvizītiem (piemēram, būvfirmas rekvizītiem).

### Līdz šim:
1. Menedžeris pasūtījumā norāda `Saistītā klienta nr.`.
2. Standarta Business Central automātiski **nepiemēro** saistītā klienta atlaides, jo tās ir piesaistītas meistaram, nevis rēķina firmai.
3. Nācās manuāli meklēt katrai precei vai preču grupai meistara atlaides un ar roku katrai rindai ierakstīt `Rindas atlaide %`.

### Ar BC Atlaižu Helperi:
1. Atverot pasūtījumu (Page 42), ekrāna apakšējā labajā stūrī parādās poga **`⚡ Piemērot atlaides`** ar automātiski atpazītu saistīto klientu.
2. Uzklikšķinot uz tās, atveras pārskatāms **Atlaižu priekšskatījuma logs**:
   - Parāda katru pasūtījuma rindu, artikulu, nosaukumu un daudzumu;
   - Automātiski atrod un aprēķina precīzo atlaides % (pēc preces tiešā koda, pēc preču atlaižu grupas vai vispārējās klienta atlaides);
   - Skaidri norāda atlaides pamatojumu;
   - Iekrāso ar dzeltenu brīdinājumu, ja kādai rindai jau bija cita manuāla atlaide.
3. Nospiežot **`⚡ Automātiski ierakstīt`**:
   - Helperis automātiski, secīgi un zibenīgi aizpilda lauku `Rindas atlaide %` visām rindām;
   - Business Central nekavējoties pārrēķina summas un piemēro pareizās partnera cenas!

---

## 📦 Uzstādīšanas instrukcija (30 sekundes)

### Microsoft Edge pārlūkā:
1. Atveriet Microsoft Edge un adreses joslā ievadiet:
   ```text
   edge://extensions
   ```
2. Kreisajā sānjoslā **ieslēdziet slēdzi "Developer mode"** (Izstrādātāja režīms).
3. Lapas augšpusē nospiediet pogu **"Load unpacked"** (Ielādēt neiepakotu).
4. Izvēlieties šo repozitorija / paplašinājuma mapi (vai atarhivēto zip saturu).
5. Edge rīkjoslā uzklikšķiniet uz puzles ikonas un piespraudiet (acs ikona) **"BC atlaižu helperis"**, lai ikona vienmēr būtu redzama.

---

### Google Chrome pārlūkā:
1. Atveriet Google Chrome un adreses joslā ievadiet:
   ```text
   chrome://extensions
   ```
2. Augšējā labajā stūrī **ieslēdziet slēdzi "Izstrādātāja režīms" (Developer mode)**.
3. Augšējā kreisajā stūrī nospiediet **"Ielādēt neiepakotu" (Load unpacked)** un izvēlieties šo pašu mapi.

---

## 🛠️ Kā pirmoreiz ielasīt klienta atlaides no Page 7004?

1. Helpera logā (vai nospiežot `🔄 Atjaunot no Page 7004`) atveriet lapu 7004:
   ```text
   https://amfbc.amf.lv:8443/AMF/?page=7004
   ```
2. Augšējā filtra joslā laukā **"Pārdošanas kods"** ievadiet klienta numuru (piemēram `011420`).
3. Lapas pašā augšā parādīsies zila josla: **"⚡ BC Atlaižu Helperis: Gatavs nolasīt un saglabāt šī klienta rindu atlaides kešā"**.
4. Nospiediet pogu **"💾 Saglabāt atlaides helperim"**.
5. Gatavs! Visas šī klienta atlaides ir saglabātas un turpmāk automātiski darbosies visos viņa pasūtījumos!
