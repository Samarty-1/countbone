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
 *   5. Optional: run sendTestAlert to check the alert email reaches you.
 *
 * Every new request emails the account that ran this script, with all the
 * answers; replying to that email goes to the client. Run createPilotForm
 * only once: each run makes a new form, sheet and alert.
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

  // Alert: email the person running this script whenever a request arrives.
  PropertiesService.getScriptProperties().setProperty('SHEET_URL', sheet.getUrl());
  ScriptApp.newTrigger('notifyNewRequest').forForm(form).onFormSubmit().create();

  Logger.log('Alerts go to: ' + Session.getEffectiveUser().getEmail());
  Logger.log('Form (share or edit): ' + form.getEditUrl());
  Logger.log('Replies sheet: ' + sheet.getUrl());
  Logger.log('Paste this into presentation/index.html:\n\nconst PILOT_FORM=' +
    JSON.stringify(config, null, 1) + ';');
}

/** Runs on every form submission (set up by createPilotForm). */
function notifyNewRequest(e) {
  var answers = {};
  e.response.getItemResponses().forEach(function (r) {
    answers[r.getItem().getTitle()] = String(r.getResponse());
  });
  sendAlert_(answers, e.response.getTimestamp());
}

/** Run this once to check the alert email arrives, without a real request. */
function sendTestAlert() {
  sendAlert_({
    'Your name': 'Test Person', 'Company': 'Example Logistics',
    'Work email': Session.getEffectiveUser().getEmail(), 'Phone': '',
    'Type of site': 'Warehouse', 'Stock system': 'NetSuite', 'Number of sites': '2',
    'Preferred start (YYYY-MM)': '2026-11', 'Aisles to pilot': 'Aisles A and B',
    'Anything else': 'This is a test alert.'
  }, new Date(), true);
}

function sendAlert_(answers, when, isTest) {
  var me = Session.getEffectiveUser().getEmail();
  var company = answers['Company'] || 'unknown company';
  var sheetUrl = PropertiesService.getScriptProperties().getProperty('SHEET_URL') || '';
  var rows = Object.keys(answers).map(function (k) {
    return '<tr><td style="padding:6px 12px 6px 0;color:#4A5566;vertical-align:top">' + esc_(k) +
      '</td><td style="padding:6px 0;font-weight:600">' + (esc_(answers[k]) || '—') + '</td></tr>';
  }).join('');
  var text = Object.keys(answers).map(function (k) { return k + ': ' + (answers[k] || '-'); }).join('\n');
  var options = {
    to: me,
    subject: (isTest ? '[Test] ' : '') + 'New pilot request: ' + company,
    body: 'New Countbone pilot request (' + when + ')\n\n' + text +
      (sheetUrl ? '\n\nAll requests: ' + sheetUrl : ''),
    htmlBody: '<p style="font-family:Arial,sans-serif">New Countbone pilot request, ' + esc_(String(when)) + '</p>' +
      '<table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">' + rows + '</table>' +
      (sheetUrl ? '<p style="font-family:Arial,sans-serif"><a href="' + sheetUrl + '">Open all requests</a></p>' : '') +
      '<p style="font-family:Arial,sans-serif;color:#4A5566">Reply to this email to answer the client directly.</p>'
  };
  var client = answers['Work email'];
  if (client && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client)) options.replyTo = client;
  MailApp.sendEmail(options);
}

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
