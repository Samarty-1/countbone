/**
 * Creates the "Book a pilot" Google Form for presentation/index.html,
 * links it to a Google Sheet that collects the replies, and logs the
 * PILOT_FORM block to paste into index.html.
 *
 * How to run (about 2 minutes):
 *   1. Go to https://script.google.com and click "New project".
 *   2. Replace the code with this file and click Run (function: createPilotForm).
 *   3. Allow access when Google asks (it creates a form and a sheet in your Drive).
 *   4. Open "Execution log", copy the PILOT_FORM block, and paste it over the
 *      empty PILOT_FORM block near the bottom of presentation/index.html.
 */
function createPilotForm() {
  var form = FormApp.create('Countbone: book a pilot');
  form.setDescription('Tell us about your site and we will reply with a setup date.');
  form.setConfirmationMessage('Thanks. We will reply with a setup date for your pilot.');
  form.setCollectEmail(false);
  try { form.setRequireLogin(false); } catch (e) { /* only on Google Workspace accounts */ }

  // Keys must match the input names in index.html; choices must match its <option>s.
  var items = {
    name: form.addTextItem().setTitle('Your name').setRequired(true),
    company: form.addTextItem().setTitle('Company').setRequired(true),
    email: form.addTextItem().setTitle('Work email').setRequired(true),
    phone: form.addTextItem().setTitle('Phone'),
    siteType: form.addMultipleChoiceItem().setTitle('Type of site')
      .setChoiceValues(['Warehouse', '3PL', 'Retail stores', 'Other']),
    system: form.addMultipleChoiceItem().setTitle('Stock system')
      .setChoiceValues(['Shopify', 'NetSuite', 'SAP', 'Spreadsheet / CSV', 'Other']),
    sites: form.addTextItem().setTitle('Number of sites'),
    start: form.addTextItem().setTitle('Preferred start (YYYY-MM)'),
    aisles: form.addTextItem().setTitle('Aisles to pilot'),
    notes: form.addParagraphTextItem().setTitle('Anything else')
  };

  var sheet = SpreadsheetApp.create('Countbone pilot requests');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());

  // A pre-filled link for one answer reveals that question's entry id.
  var fields = {};
  Object.keys(items).forEach(function (key) {
    var item = items[key];
    var answer;
    if (item.getType() === FormApp.ItemType.MULTIPLE_CHOICE) {
      answer = item.asMultipleChoiceItem().createResponse('Other');
    } else if (item.getType() === FormApp.ItemType.PARAGRAPH_TEXT) {
      answer = item.asParagraphTextItem().createResponse('x');
    } else {
      answer = item.asTextItem().createResponse('x');
    }
    var url = form.createResponse().withItemResponse(answer).toPrefilledUrl();
    fields[key] = url.match(/(entry\.\d+)=/)[1];
  });

  var action = form.getPublishedUrl().replace(/\/viewform.*$/, '/formResponse');
  var config = { action: action, fields: fields };

  Logger.log('Form (share or edit): ' + form.getEditUrl());
  Logger.log('Replies sheet: ' + sheet.getUrl());
  Logger.log('Paste this into presentation/index.html:\n\nconst PILOT_FORM=' +
    JSON.stringify(config, null, 1) + ';');
}
