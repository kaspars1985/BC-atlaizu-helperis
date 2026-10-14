# BC Menedžera Palīgs

Vieds un ērts **Microsoft Edge** un **Google Chrome** pārlūka paplašinājums AM Furnitūra menedžeriem: saistītā klienta rindu atlaižu automātiska nolasīšana un piemērošana **Microsoft Dynamics 365 Business Central**.

---

## 🚀 Kā tas atvieglo ikdienas darbu?

Bieži rodas situācija: klients (piemēram, meistars ar kodu `011420`) pasūta preces, bet rēķins un pasūtījums tiek noformēts uz citas firmas rekvizītiem (piemēram, būvfirmas rekvizītiem).

### Līdz šim:
1. Menedžeris pasūtījumā norāda `Saistītā klienta nr.`.
2. Standarta Business Central automātiski **nepiemēro** saistītā klienta atlaides, jo tās ir piesaistītas meistaram, nevis rēķina firmai.
3. Menedžerim nācās manuāli meklēt katrai precei vai preču grupai meistara atlaides un ar roku katrai rindai ierakstīt `Rindas atlaide %`.

### Ar BC Menedžera Palīgu:
1. Atverot pasūtījumu (Page 42), ekrāna apakšējā labajā stūrī parādās poga **`⚡ Piemērot atlaides`** ar automātiski atpazītu saistīto klientu.
2. Uzklikšķinot uz tās, atveras pārskatāms **Atlaižu priekšskatījuma logs**:
   - Parāda katru pasūtījuma rindu, artikulu, nosaukumu un daudzumu;
   - Automātiski atrod un aprēķina precīzo atlaides % (pēc preces tiešā koda, pēc preču atlaižu grupas vai vispārējās klienta atlaides);
   - Skaidri norāda atlaides pamatojumu;
   - Iekrāso ar dzeltenu brīdinājumu, ja kādai rindai jau bija cita manuāla atlaide.
3. Nospiežot **`⚡ Ierakstīt atlaides pasūtījumā`**:
   - Palīgs automātiski un secīgi aizpilda lauku `Rindas atlaide %` visām rindām ar progresa indikatoru;
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
4. Izvēlieties mapi:
   ```text
   C:\Users\KasparsCiematnieks\Desktop\ANTIGRAVITY\BC menedžera palīgs
   ```
5. Edge rīkjoslā uzklikšķiniet uz puzles ikonas un piespraudiet (acs ikona) **"BC menedžera palīgs"**, lai ikona vienmēr būtu redzama.

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

1. Paplašinājuma logā (vai nospiežot `🔄 Atjaunot no Page 7004`) atveriet lapu 7004:
   ```text
   https://amfbc.amf.lv:8443/AMF/?page=7004
   ```
2. Augšējā filtra joslā laukā **"Pārdošanas kods"** ievadiet klienta numuru (piemēram `011420`).
3. Lapas pašā augšā parādīsies zila josla: **"⚡ BC Menedžera Palīgs: Gatavs nolasīt un saglabāt šī klienta rindu atlaides kešā"**.
4. Nospiediet oranžo pogu **"💾 Saglabāt atlaides BC palīgam"**.
5. Gatavs! Visas šī klienta atlaides ir saglabātas un turpmāk automātiski darbosies visos viņa pasūtījumos!
