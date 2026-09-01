import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'

dayjs.extend(customParseFormat)

const bookTennis = async () => {
  const DRY_RUN_MODE = process.argv.includes('--dry-run')
  if (DRY_RUN_MODE) {
    console.log('----- DRY RUN START -----')
    console.log('Script lancé en mode DRY RUN. Afin de tester votre configuration, une recherche va être lancé mais AUCUNE réservation ne sera réalisée')
  }

  console.log(`${dayjs().format()} - Starting searching tennis`)
  const browser = await chromium.launch({ headless: true, slowMo: 0, timeout: 90000 })

  console.log(`${dayjs().format()} - Browser started`)
  const page = await browser.newPage()
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha-invisible/invisible-captcha-infos', (route) => route.abort())
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captchas**', (route) => route.abort())
  page.setDefaultTimeout(90000)
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')

  await page.click('#button_suivi_inscription')
  await page.fill('#username', config?.account?.email || process.env.ACCOUNT_EMAIL)
  await page.fill('#password', config?.account?.password || process.env.ACCOUNT_PASSWORD)
  await page.click('#form-login >> button')

  console.log(`${dayjs().format()} - User connected`)

  // wait for login redirection before continue
  await page.waitForSelector('.main-informations')

  try {
    const locations = !Array.isArray(config.locations) ? Object.keys(config.locations) : config.locations
    locationsLoop:
    for (const [i, location] of locations.entries()) {
      const logLocation = process.env.GITHUB_ACTIONS ? `location ${i + 1}` : location
      console.log(`${dayjs().format()} - Search at ${logLocation}`)
      await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')

      // select tennis location
      await page.locator('.tokens-input-text').pressSequentially(`${location} `)
      await page.waitForSelector(`.tokens-suggestions-list-element >> text="${location}"`)
      await page.click(`.tokens-suggestions-list-element >> text="${location}"`)

      // select date
      await page.click('#when')
      const date = config.date ? dayjs(config.date, 'D/MM/YYYY') : dayjs().add(6, 'days')
      await page.waitForSelector(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.waitForSelector('.date-picker', { state: 'hidden' })

      await page.click('#rechercher')

      // wait until the results page is fully loaded before continue
      await page.waitForLoadState('domcontentloaded')

      // Les resultats sont ranges par tennis dans les onglets #bookmarkList : les
      // tennis favoris du compte, plus celui qu'on vient de rechercher. L'onglet
      // actif est le premier favori, pas forcement celui qu'on cherche. Sans le
      // selectionner on lit — et on reserverait — les creneaux d'un AUTRE tennis.
      const tabSel = `#bookmarkList a[data-toggle="tab"][aria-controls="${location}"]`
      let tab = page.locator(tabSel).first()
      if (!await page.locator(tabSel).count()) {
        // Repli si le libelle affiche differe legerement de aria-controls.
        tab = page.locator('#bookmarkList a[data-toggle="tab"]', { hasText: location }).first()
      }
      if (!await tab.count()) {
        console.log(`${dayjs().format()} - Onglet de resultats introuvable pour ${logLocation}`)
        continue
      }

      // Le bouton de fermeture de l'onglet est DANS le lien : on vise le libelle
      // pour ne pas retirer le tennis de la liste par un clic mal centre.
      const tabLabel = tab.locator('.tennis-label')
      await (await tabLabel.count() ? tabLabel : tab).first().click()

      // Un onglet inactif est masque : ses creneaux ne seraient jamais visibles.
      const pane = `[id="${(await tab.getAttribute('href')).slice(1)}"]`
      await page.waitForSelector(`${pane}.active`, { timeout: 15000 })

      let selectedHour
      hoursLoop:
      for (const hour of config.hours) {
        const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${hour}:00:00"]`
        const slotSel = `${pane} ${dateDeb}`
        if (await page.locator(slotSel).count()) {
          try {
            if (await page.isHidden(slotSel)) {
              // Chaque heure est un panneau bootstrap replie. Le declencheur est le
              // <a data-toggle="collapse"> qui ENVELOPPE l'entete, pas l'entete
              // elle-meme. On part du creneau et on remonte au panneau qui le
              // contient, au lieu de reconstruire `#head<Nom><hh>h` depuis la config :
              // cet id n'existe pas quand le nom saisi n'est pas celui de l'onglet.
              const toggle = page.locator(`${pane} .panel-default:has(${dateDeb}) a[data-toggle="collapse"]`).first()
              if (!await toggle.count()) {
                console.log(`${dayjs().format()} - Accordeon introuvable pour ${hour}h, passage a l'heure suivante`)
                continue
              }

              await toggle.click()
              await page.waitForSelector(slotSel, { state: 'visible', timeout: 15000 })
            }
          } catch (err) {
            // Un echec sur une heure ne doit PAS tuer la run : on tente l'heure suivante.
            console.log(`${dayjs().format()} - Echec a ${hour}h (${err.name}), passage a l'heure suivante`)
            continue
          }

          const courtNumbers = !Array.isArray(config.locations) ? config.locations[location] : []
          const slots = await page.locator(slotSel).all()
          for (const slot of slots) {
            // `slotAttrs` reste purement attributaire : a l'interieur de :has() le
            // selecteur est relatif au .row.tennis-court, un prefixe d'onglet y
            // chercherait un descendant et ne matcherait jamais.
            const slotAttrs = `[courtid="${await slot.getAttribute('courtid')}"]${dateDeb}`
            const bookSlotButton = `${pane} ${slotAttrs}`
            if (courtNumbers.length > 0) {
              const courtName = (await page.locator(`.court:left-of(${bookSlotButton})`).innerText()).trim()
              if (!courtNumbers.includes(parseInt(courtName.match(/Court N°(\d+)/)[1]))) {
                continue
              }
            }

            const [priceType, courtType] = (await page.locator(`${pane} .row.tennis-court:has(${slotAttrs})`).locator('.price-description').innerHTML()).split('<br>')
            if (!config.priceType.includes(priceType) || !config.courtType.includes(courtType)) {
              continue
            }
            selectedHour = hour
            await page.click(bookSlotButton)

            break hoursLoop
          }
        }
      }

      if (await page.title() !== 'Paris | TENNIS - Reservation') {
        console.log(`${dayjs().format()} - Failed to find reservation for ${logLocation}`)
        continue
      }

      await page.waitForSelector('.order-steps-infos h2 >> text="1 / 3 - Validation du court"')

      for (const [i, player] of config.players.entries()) {
        if (i > 0) {
          await page.click('.addPlayer')
        }
        await page.waitForSelector(`[name="player${i + 1}"]`)
        await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
        await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
      }

      await page.keyboard.press('Enter')

      await page.waitForSelector('#order_select_payment_form #paymentMode', { state: 'attached' })
      const paymentMode = page.locator('#order_select_payment_form #paymentMode')
      await paymentMode.evaluate(el => {
        el.removeAttribute('readonly')
        el.style.display = 'block'
      })
      await paymentMode.fill('existingTicket')

      if (DRY_RUN_MODE) {
        console.log(`${dayjs().format()} - Fausse réservation faite : ${logLocation}`)
        if (!process.env.GITHUB_ACTIONS) console.log(`pour le ${date.format('YYYY/MM/DD')} à ${selectedHour}h`)
        console.log('----- DRY RUN END -----')
        console.log('Pour réellement réserver un crénau, relancez le script sans le paramètre --dry-run')

        // Annuler demande de revenir a l'etape 1/3 puis d'ouvrir la modale qui
        // porte `#btnCancelBooking`. Ce retour arriere traverse le controle
        // captcha, que le contournement en tete de script fait echouer : en
        // headless l'annulation n'aboutit generalement pas. On la tente sans
        // bloquer — le creneau retenu se libere seul au bout de 5 minutes.
        try {
          // Sur l'ecran de paiement les boutons de navigation portent la classe
          // `hide`, comme `#envoyer` ci-dessous : sans la retirer, le clic attend
          // 90 s une visibilite qui ne viendra jamais.
          const previous = page.locator('#previous')
          await previous.evaluate(el => el.classList.remove('hide'))
          await previous.click({ timeout: 15000 })
          await page.waitForSelector('#btnCancelBooking', { state: 'attached', timeout: 15000 })
          if (await page.locator('#btnCancelBooking').isHidden()) {
            await page.click('button#precedent', { timeout: 15000 })
            await page.waitForSelector('#btnCancelBooking', { state: 'visible', timeout: 15000 })
          }
          await page.click('#btnCancelBooking', { timeout: 15000 })
          console.log(`${dayjs().format()} - Réservation de test annulée`)
        } catch (err) {
          console.log(`${dayjs().format()} - Annulation automatique impossible (${err.name}), probablement le contrôle captcha : le créneau retenu se libèrera seul dans 5 minutes`)
        }

        break locationsLoop
      }

      const submit = page.locator('#order_select_payment_form #envoyer')
      await submit.evaluate(el => el.classList.remove('hide'))
      await submit.click()

      await page.waitForSelector('.confirmReservation')

      // Extract reservation details
      const address = (await page.locator('.address').textContent()).trim().replace(/( ){2,}/g, ' ')
      const dateStr = (await page.locator('.date').textContent()).trim().replace(/( ){2,}/g, ' ')
      const court = (await page.locator('.court').textContent()).trim().replace(/( ){2,}/g, ' ')

      if (!process.env.GITHUB_ACTIONS) {
        console.log(`${dayjs().format()} - Réservation faite : ${address}`)
        console.log(`pour le ${dateStr}`)
        console.log(`sur le ${court}`)
      } else {
        console.log('Réservation faite, regardez vos emails ou rendez-vous sur votre compte tennis.paris.fr pour plus de détails sur votre réservation.')
      }

      const [day, month, year] = [date.date(), date.month() + 1, date.year()]
      const hourMatch = dateStr.match(/(\d{2})h/)
      const hour = hourMatch ? Number(hourMatch[1]) : 12
      const start = [year, month, day, hour, 0]
      const duration = { hours: 1, minutes: 0 }
      const event = {
        start,
        duration,
        title: 'Réservation Tennis',
        description: `Court: ${court}\nAdresse: ${address}`,
        location: address,
        status: 'CONFIRMED',
      }

      const createdEvent = createEvent(event)
      if (createdEvent.error) {
        console.log('ICS creation error:', createdEvent.error)

        break
      }

      const { value } = createdEvent
      if (!process.env.GITHUB_ACTIONS) {
        writeFileSync('event.ics', value)
      }
      if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
        await notify(Buffer.from(value, 'utf8'), 'event.ics',
          `Confirmation pour le ${date.format('DD/MM/YYYY')} - ${hour}h`, {
            domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
            topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
          })
      }

      break
    }
  } catch (e) {
    console.log(e)
    const screenshot = await page.screenshot({ path: 'img/failure.png' })

    if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
      await notify(screenshot, 'failure.png', 'Erreur lors de l\'execution du programme.', {
        domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
        topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
      })
    }
  }

  await browser.close()
}

bookTennis()
