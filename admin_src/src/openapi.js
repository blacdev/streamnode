// OpenAPI 3.0 description of the management API, served at /api/v1/openapi.json
// and rendered interactively at /api/v1/docs.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({ 'application/json': example ? { schema, example } : { schema } });
const ok = (description, schema) => ({ description, content: json(schema) });
const error = (description) => ({ description, content: json(ref('Error')) });

const AUTH_ERRORS = {
  401: error('No credentials were sent, or they are not valid.'),
  403: error('The credentials are valid but not allowed to do this.'),
};
const slugParam = { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, example: 'powerbeats' };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const fromDate = { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'First UTC day, inclusive. Defaults to the first day of the current month.' };
const toDate = { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Last UTC day, inclusive. Defaults to today.' };

const stationWritable = {
  name: { type: 'string', maxLength: 100, example: 'Power Beats FM' },
  primary_url: { type: 'string', format: 'uri', description: 'The station\'s own stream. Relayed byte-for-byte: codec and bitrate are never changed.', example: 'https://encoder.example.com/live' },
  backup_url: { type: 'string', format: 'uri', nullable: true, description: 'Used when the primary cannot be reached, drops or stalls. Should carry the same codec as the primary.', example: 'https://backup.example.com/live' },
  metadata_url: { type: 'string', format: 'uri', nullable: true, description: 'Optional endpoint polled for the current title, artist and artwork (JSON or plain text) while the primary plays, and while the backup plays if `backup_titles_from_primary` is true. When absent, titles embedded in the playing stream are used.', example: 'https://example.com/nowplaying.json' },
  artwork_url: { type: 'string', format: 'uri', nullable: true, description: 'Optional station artwork, used whenever the metadata URL supplies none. If it stops answering with an image and the station has an uploaded image (`artwork_file_id`), that image is used instead.', example: 'https://example.com/logo.png' },
  backup_titles_from_primary: { type: 'boolean', default: false, description: 'The backup stream carries the same programme as the primary, so `metadata_url` describes it too. When false, the titles shown while the backup plays are the ones in the backup\'s own stream. Has no effect without both `backup_url` and `metadata_url`.' },
  default_title: { type: 'string', nullable: true, maxLength: 200, description: 'Shown as the title when neither the stream nor the metadata URL names what is playing (or the metadata URL has stopped answering), and while the fallback file plays.', example: 'More music, less talk' },
  default_artist: { type: 'string', nullable: true, maxLength: 200, description: 'Shown as the artist in the same situations as `default_title`.', example: 'Power Beats' },
  artwork_file_id: { type: 'integer', nullable: true, description: 'An uploaded image (`kind: image`) from the station\'s account, shown when the metadata URL supplies no artwork and `artwork_url` is empty or does not answer with an image. Served to anyone at `default_artwork_url`.' },
  failover_delay_secs: { type: 'integer', minimum: 1, maximum: 300, default: 6, description: 'Seconds a stream may be down or silent before the station moves to the next source (primary, then backup, then the fallback file). Returning to a stream that is back is immediate.' },
  silence_detection: { type: 'boolean', default: true, description: 'Treat a stream that keeps sending but carries only silence as having no audio. Applies to MP3 and AAC streams.' },
  noise_detection: { type: 'boolean', default: true, description: 'Treat a stream that carries nothing but steady noise (hiss), however loud, as having no audio. Only while `silence_detection` is on.' },
  silence_threshold_db: { type: 'integer', nullable: true, minimum: -90, maximum: -10, description: 'How quiet counts as silent for this station, in dB below full level. null uses the server\'s `SILENCE_THRESHOLD_DB` (-55).' },
  ident_file_id: { type: 'integer', nullable: true, description: 'An uploaded file played once at every change of source: on leaving a failed stream and on returning to one that is back. Without it, MP3 stations fade between sources. Must belong to the station\'s account, match the stream\'s format and be no longer than the ident limit.' },
  fallback_file_id: { type: 'integer', nullable: true, description: 'An uploaded file looped while neither stream has audio. Must belong to the station\'s account and match the stream\'s format.' },
  max_listeners: { type: 'integer', minimum: 0, description: 'Concurrent listener cap, 0 for unlimited. Also the number of listeners the station is charged for; an unlimited station is charged for its highest concurrent listeners in the month. Administrators only.', example: 500 },
  billing_bitrate_kbps: { type: 'integer', nullable: true, minimum: 8, maximum: 2000, description: 'The bitrate the station is charged at. null uses the bitrate detected on its stream. Administrators only.' },
  discount_percent: { type: 'number', minimum: 0, maximum: 100, description: 'Taken off this station\'s calculated price. Administrators only.' },
  price_override: { type: 'number', nullable: true, minimum: 0, description: 'A fixed monthly price that replaces the calculated one. Administrators only.' },
  plan_type: { type: 'string', enum: ['listeners', 'bandwidth'], default: 'listeners', description: '`listeners`: the station pays for a number of listeners at once (`max_listeners`). `bandwidth`: it pays for an amount of data each month (`bandwidth_gb`) and has no listener limit. Administrators only.' },
  bandwidth_gb: { type: 'number', nullable: true, description: 'A bandwidth plan\'s monthly data, in gigabytes (1,000,000,000 bytes). Starts again each calendar month (UTC). Required when `plan_type` is `bandwidth`. Administrators only.' },
  overage_mode: { type: 'string', enum: ['capped', 'pay_as_you_go'], default: 'capped', description: 'What happens when the plan is used up. For a bandwidth plan: `capped` takes the station off the air until the new month, `pay_as_you_go` charges each further gigabyte. For a listener plan, beyond `max_listeners`: `capped`: further listeners are turned away. `pay_as_you_go`: they are let in and charged by the pay-as-you-go rate. Administrators only.' },
  listener_ceiling: { type: 'integer', nullable: true, minimum: 1, description: 'With pay as you go, the most listeners the station may have at once. null for no ceiling. Administrators only.' },
  subscription_ends_on: { type: 'string', format: 'date', nullable: true, description: 'The last day paid for. Produces notices to the owner; the station is not suspended automatically. Administrators only.' },
  external_id: { type: 'string', nullable: true, maxLength: 100, description: 'Your own identifier for this station, such as a billing service id. Administrators only.', example: 'whmcs-service-1042' },
  is_active: { type: 'boolean', description: 'false suspends the station. Administrators only.' },
  user_id: { type: 'integer', description: 'Owning account. Administrators only; defaults to the caller. Changing it moves the station to that account and clears its ident and fallback audio, which belong to an account.' },
};

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'StreamNode API',
    version: '1.0.0',
    description: [
      'Management API for the radio rebroadcast gateway. Provision stations, suspend and resume them, read live listener counts and pull usage for billing.',
      '',
      '**Authentication.** Send an API key in the `X-API-Key` header (or as `Authorization: Bearer <key>`). Keys belong to an account: an administrator key can manage everything, a tenant key only that tenant\'s stations. The dashboard signs in with `POST /auth/login` and uses the returned session token the same way.',
      '',
      '**Errors.** Every error has the shape `{"error": {"code", "message", "details"}}`. `422` responses list the offending fields in `details`.',
      '',
      '**Listener URLs.** A station with slug `powerbeats` streams at `/powerbeats` (also `/powerbeats.mp3`, `/powerbeats.aac`), with playlist files at `/powerbeats.m3u` and `/powerbeats.pls`.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1' }],
  security: [{ ApiKey: [] }, { Bearer: [] }],
  tags: [
    { name: 'Stations', description: 'Provision and manage relayed stations.' },
    { name: 'Statistics', description: 'Live status, history and billing usage.' },
    { name: 'Files', description: 'Uploaded audio: station idents and the files played when a station\'s streams have no audio. The gateway never converts audio, so a file must already match the stream it is used on.' },
    { name: 'Settings', description: 'Gateway-wide settings and where uploaded files are kept.' },
    { name: 'Billing', description: 'What stations and accounts cost per month, how close they are to their limits, and the notices sent about that. Prices follow from the measured cost of a listener.' },
    { name: 'Accounts', description: 'Tenant accounts and API keys.' },
    { name: 'Servers', description: 'Streaming servers that listeners are spread across.' },
    { name: 'Updates', description: 'Version monitoring, installing updates, and the HTTPS certificate.' },
    { name: 'Session', description: 'Dashboard sign-in.' },
    { name: 'Public', description: 'No authentication required.' },
  ],
  paths: {
    '/stations': {
      get: {
        tags: ['Stations'], summary: 'List stations',
        description: 'Administrators see every station; tenants see their own. Each entry includes live listener state.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'user_id', in: 'query', schema: { type: 'integer' }, description: 'Administrators only: restrict to one account.' },
          { name: 'external_id', in: 'query', schema: { type: 'string' }, description: 'Find the station carrying this external identifier.' },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Match against slug and name.' },
        ],
        responses: { 200: ok('A page of stations.', ref('StationList')), ...AUTH_ERRORS },
      },
      post: {
        tags: ['Stations'], summary: 'Create a station',
        description: 'Fails with `409` if the slug exists. For provisioning that may be retried, prefer `PUT /stations/{slug}`.',
        requestBody: { required: true, content: json(ref('StationCreate')) },
        responses: { 201: ok('The new station.', ref('Station')), 409: error('The slug is already in use.'), 422: error('Validation failed.'), ...AUTH_ERRORS },
      },
    },
    '/stations/{slug}': {
      parameters: [slugParam],
      get: { tags: ['Stations'], summary: 'Get a station', responses: { 200: ok('The station.', ref('Station')), 404: error('No such station.'), ...AUTH_ERRORS } },
      put: {
        tags: ['Stations'], summary: 'Create or update a station (idempotent)',
        description: 'Creates the station if the slug is free, otherwise updates the fields supplied and leaves the rest untouched. Safe to repeat, which makes it the right call for provisioning modules.',
        requestBody: { required: true, content: json(ref('StationUpsert')) },
        responses: { 200: ok('Updated.', ref('Station')), 201: ok('Created.', ref('Station')), 409: error('The slug belongs to another account.'), 422: error('Validation failed.'), ...AUTH_ERRORS },
      },
      patch: {
        tags: ['Stations'], summary: 'Update some fields',
        description: 'Source URL changes reach the engine within a few seconds; listeners stay connected while it switches. Administrators may also change `slug`, which changes the public stream URL.',
        requestBody: { required: true, content: json(ref('StationPatch')) },
        responses: { 200: ok('The updated station.', ref('Station')), 404: error('No such station.'), 422: error('Validation failed.'), ...AUTH_ERRORS },
      },
      delete: {
        tags: ['Stations'], summary: 'Delete a station',
        description: 'Disconnects listeners and permanently removes the station **and its statistics**. Tenants may delete their own stations. Read usage first if it is still needed.',
        responses: { 204: { description: 'Deleted.' }, 404: error('No such station.'), ...AUTH_ERRORS },
      },
    },
    '/stations/{slug}/suspend': {
      parameters: [slugParam],
      post: { tags: ['Stations'], summary: 'Suspend a station', description: 'Administrators only. Listeners are disconnected within a few seconds and new connections get `503`. Configuration and history are kept.', responses: { 200: ok('The suspended station.', ref('Station')), 404: error('No such station.'), ...AUTH_ERRORS } },
    },
    '/stations/{slug}/unsuspend': {
      parameters: [slugParam],
      post: { tags: ['Stations'], summary: 'Resume a suspended station', description: 'Administrators only.', responses: { 200: ok('The active station.', ref('Station')), 404: error('No such station.'), ...AUTH_ERRORS } },
    },
    '/stations/{slug}/status': {
      parameters: [slugParam],
      get: { tags: ['Statistics'], summary: 'Live status of one station', description: 'Current listener count, which source is on air and what is playing. Updated every two seconds.', responses: { 200: ok('Live state.', ref('StationStatus')), 404: error('No such station.'), ...AUTH_ERRORS } },
    },
    '/stations/{slug}/stats': {
      parameters: [slugParam],
      get: {
        tags: ['Statistics'], summary: 'Listener and bandwidth history',
        description: 'A time series for charts. Buckets with no activity are omitted. Minute and hour resolution are kept for 90 days by default; day resolution is kept permanently.',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'ISO 8601 or Unix seconds. Defaults to 24 hours before `to`.' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Defaults to now.' },
          { name: 'interval', in: 'query', schema: { type: 'string', enum: ['minute', 'hour', 'day'] }, description: 'Defaults to minute for ranges up to 6 hours, hour up to 14 days, day beyond.' },
        ],
        responses: { 200: ok('The series.', ref('StatsSeries')), 404: error('No such station.'), 422: error('Bad range or interval.'), ...AUTH_ERRORS },
      },
    },
    '/stations/{slug}/usage': {
      parameters: [slugParam],
      get: { tags: ['Statistics'], summary: 'Usage totals for one station', parameters: [fromDate, toDate], responses: { 200: ok('Totals for the period.', ref('StationUsage')), 404: error('No such station.'), ...AUTH_ERRORS } },
    },
    '/usage': {
      get: {
        tags: ['Statistics'], summary: 'Usage totals for every station',
        description: 'One row per station for a period of UTC days: the call a billing run makes once per cycle. Tenants get their own stations.',
        parameters: [fromDate, toDate, { name: 'user_id', in: 'query', schema: { type: 'integer' }, description: 'Administrators only.' }],
        responses: { 200: ok('Usage report.', ref('UsageReport')), ...AUTH_ERRORS },
      },
    },
    '/metrics': {
      get: { tags: ['Statistics'], summary: 'Live metrics for every station', description: 'All-time bytes (including traffic not yet written to the database) and current listeners.', responses: { 200: ok('One entry per station.', { type: 'array', items: ref('Metric') }), ...AUTH_ERRORS } },
    },
    '/overview': {
      get: { tags: ['Statistics'], summary: 'Headline numbers', responses: { 200: ok('Totals across visible stations.', ref('Overview')), ...AUTH_ERRORS } },
    },
    '/files': {
      get: {
        tags: ['Files'], summary: 'List uploaded files',
        description: 'The caller\'s files, audio and images, with the account\'s storage use. Administrators may pass `user_id` (an account id, or `all`).',
        parameters: [{ name: 'user_id', in: 'query', schema: { type: 'string' } }, { name: 'kind', in: 'query', schema: { type: 'string', enum: ['audio', 'image'] }, description: 'Only audio files, or only images.' }],
        responses: { 200: ok('Files, storage use and limits.', ref('FileList')), ...AUTH_ERRORS },
      },
      post: {
        tags: ['Files'], summary: 'Upload a file',
        description: [
          'The request body is the file itself (not a form). Example:',
          '',
          '`curl -H "X-API-Key: $KEY" --data-binary @ident.mp3 "https://stream.example.com/api/v1/files?filename=ident.mp3&use=ident&station=powerbeats"`',
          '',
          'The file is read, not converted. It is refused with `422 file_not_usable`, and a message saying what to change, when it is not MP3 or AAC (ADTS), when `use=ident` and it is longer than the ident limit, or when `station` is given and it does not match that station\'s stream (codec, bitrate, sample rate, channels; MP3 must be constant bitrate). It is refused with `413 quota_exceeded` when it does not fit in the account\'s remaining storage.',
          '',
          'With `station` and `use`, the file is also set as that station\'s ident, fallback or image.',
          '',
          'A JPEG, PNG, WebP or GIF picture is recognised by its content and stored as an image (`kind: image`), for use as a station\'s image (`use=artwork`). It may be at most 5 MB (`413 image_too_large`), counts toward the same storage quota, and is never converted.',
        ].join('\n'),
        parameters: [
          { name: 'filename', in: 'query', schema: { type: 'string' }, description: 'The file\'s own name, e.g. `ident.mp3`.' },
          { name: 'name', in: 'query', schema: { type: 'string', maxLength: 100 }, description: 'Display name; listeners see it as the title while a fallback file plays. Defaults to the file name without its extension.' },
          { name: 'use', in: 'query', schema: { type: 'string', enum: ['ident', 'fallback', 'artwork'] }, description: '`artwork` is the station\'s image and needs a picture; the others need audio.' },
          { name: 'station', in: 'query', schema: { type: 'string' }, description: 'Slug of a station to check the file against and assign it to. Requires `use`.' },
          { name: 'convert', in: 'query', schema: { type: 'boolean', default: false }, description: '`true` is the caller\'s agreement that a file which is not in the station\'s format is re-encoded to it, matched to the stream\'s loudness, and stored in place of what was uploaded. Needs `station`. Without it such a file is refused with `conversion_needed`.' },
          { name: 'assign', in: 'query', schema: { type: 'boolean', default: true }, description: '`false` checks the file against `station` and stores it without assigning it.' },
          { name: 'user_id', in: 'query', schema: { type: 'integer' }, description: 'Administrators only: upload into another account.' },
        ],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: {
          200: ok('The account already holds this exact file; the existing one is returned (`already_stored: true`) and no storage is used.', ref('File')),
          201: ok('Stored.', ref('File')),
          202: ok('Stored and being converted to the station\'s format (`status: converting`). It can be assigned at once and plays when ready.', ref('File')),
          413: error('The file does not fit in the account\'s remaining storage (`quota_exceeded`), or is an image larger than 5 MB (`image_too_large`).'),
          422: error('The file cannot be used (`file_not_usable`); the message says why and what to do.'),
          507: error('The server itself is out of disk space.'),
          ...AUTH_ERRORS,
        },
      },
    },
    '/files/{id}': {
      parameters: [idParam],
      get: { tags: ['Files'], summary: 'Get a file\'s details', responses: { 200: ok('The file.', ref('File')), 404: error('No such file.'), ...AUTH_ERRORS } },
      patch: { tags: ['Files'], summary: 'Rename a file', requestBody: { required: true, content: json({ type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 100 } } }) }, responses: { 200: ok('Renamed.', ref('File')), ...AUTH_ERRORS } },
      delete: {
        tags: ['Files'], summary: 'Delete a file',
        description: 'Refused with `409 file_in_use` while a station uses the file, unless `force` is passed, which also removes it from those stations.',
        parameters: [{ name: 'force', in: 'query', schema: { type: 'boolean' }, allowEmptyValue: true }],
        responses: { 204: { description: 'Deleted.' }, 409: error('A station still uses the file.'), ...AUTH_ERRORS },
      },
    },
    '/files/{id}/convert': {
      parameters: [idParam],
      post: {
        tags: ['Files'], summary: 'Convert a file for a station',
        description: 'For a file whose format differs from a station\'s stream. Calling this is the owner\'s agreement to the conversion: a converted copy is made in the stream\'s format and at the stream\'s loudness, and when it is ready it takes the original\'s place on that station. The original is removed if no other station uses it. Not possible for HE-AAC stations.',
        requestBody: { required: true, content: json({ type: 'object', required: ['station', 'use'], properties: { station: { type: 'string', description: 'Station slug.' }, use: { type: 'string', enum: ['ident', 'fallback'] } } }) },
        responses: { 202: ok('The new file, being converted.', ref('File')), 409: error('The file already matches, or is not ready.'), 422: error('It cannot be converted for this station.'), ...AUTH_ERRORS },
      },
    },
    '/files/{id}/content': {
      parameters: [idParam],
      get: { tags: ['Files'], summary: 'Download a file', parameters: [{ name: 'download', in: 'query', schema: { type: 'boolean' }, allowEmptyValue: true, description: 'Send it as an attachment.' }], responses: { 200: { description: 'The file as uploaded.', content: { 'audio/mpeg': {}, 'audio/aac': {} } }, ...AUTH_ERRORS } },
    },
    '/settings': {
      get: { tags: ['Settings'], summary: 'Read the settings', description: 'Administrators only.', responses: { 200: ok('Settings and storage state.', ref('Settings')), ...AUTH_ERRORS } },
      put: {
        tags: ['Settings'], summary: 'Change settings',
        description: 'Administrators only. Only the supplied fields change. A shorter ident limit applies to idents chosen from then on.',
        requestBody: { required: true, content: json(ref('SettingsUpdate')) },
        responses: { 200: ok('Saved.', ref('Settings')), 409: error('Dropbox must be disconnected before its app key or secret is changed.'), ...AUTH_ERRORS },
      },
    },
    '/storage/dropbox/authorize': {
      post: {
        tags: ['Settings'], summary: 'Start connecting Dropbox',
        description: 'Administrators only. Returns the address to open in a browser to approve the Dropbox app whose key and secret were saved with `PUT /settings`. The app must list `redirect_uri` among its redirect URIs. After approval Dropbox returns the browser to the dashboard and the files are copied to Dropbox.',
        responses: { 200: ok('Where to send the administrator.', { type: 'object', properties: { authorize_url: { type: 'string' }, redirect_uri: { type: 'string' }, expires_in: { type: 'integer' } } }), 409: error('The app key and secret have not been saved.'), ...AUTH_ERRORS },
      },
    },
    '/storage/dropbox': {
      delete: {
        tags: ['Settings'], summary: 'Disconnect Dropbox',
        description: 'Administrators only. Every file is first copied back to the server; if one cannot be, nothing changes and `409 files_not_retrieved` is returned. Copies in Dropbox are left there.',
        responses: { 200: ok('Disconnected.', ref('Settings')), 409: error('Some files could not be copied back.'), ...AUTH_ERRORS },
      },
    },
    '/users': {
      get: { tags: ['Accounts'], summary: 'List accounts', description: 'Administrators only.', parameters: [{ name: 'external_id', in: 'query', schema: { type: 'string' } }], responses: { 200: ok('Accounts.', { type: 'object', properties: { users: { type: 'array', items: ref('User') } } }), ...AUTH_ERRORS } },
      post: { tags: ['Accounts'], summary: 'Create an account', description: 'Administrators only. Omit `password` for an account that only uses API keys.', requestBody: { required: true, content: json(ref('UserCreate')) }, responses: { 201: ok('The new account.', ref('User')), 409: error('Username or external_id already in use.'), 422: error('Validation failed.'), ...AUTH_ERRORS } },
    },
    '/users/{id}': {
      parameters: [idParam],
      get: { tags: ['Accounts'], summary: 'Get an account', responses: { 200: ok('The account.', ref('User')), 404: error('No such account.'), ...AUTH_ERRORS } },
      patch: { tags: ['Accounts'], summary: 'Update an account', description: 'Disabling an account (`is_active: false`) blocks its keys and sign-in but leaves its stations on air; suspend stations separately.', requestBody: { required: true, content: json(ref('UserPatch')) }, responses: { 200: ok('The updated account.', ref('User')), 404: error('No such account.'), 422: error('Validation failed.'), ...AUTH_ERRORS } },
      delete: { tags: ['Accounts'], summary: 'Delete an account', description: 'Also deletes the account\'s stations, keys and statistics.', responses: { 204: { description: 'Deleted.' }, 404: error('No such account.'), ...AUTH_ERRORS } },
    },
    '/servers': {
      get: { tags: ['Servers'], summary: 'List streaming servers', description: 'Administrators only. Each entry carries the state and current listener connections reported by HAProxy.', responses: { 200: ok('Servers.', { type: 'object', properties: { managed: { type: 'boolean', description: 'false when HAProxy management is switched off.' }, servers: { type: 'array', items: ref('Server') } } }), ...AUTH_ERRORS } },
      post: { tags: ['Servers'], summary: 'Connect a server', description: 'Administrators only. The usual call sends `host`, `port` and `setup_key` for a slave node that is installed and waiting: the master contacts it, completes its setup and adds it to HAProxy, and the server then names itself. (The other way to add a server needs no API call at all: run the install command from `POST /cluster/join-tokens` on it.) Without `setup_key` the entry is only recorded, which is how an edge server with `mode: direct` is listed.', requestBody: { required: true, content: json(ref('ServerCreate')) }, responses: { 201: ok('The new server. `applied` is false if HAProxy could not be reached; the change is retried automatically.', ref('Server')), 409: error('Name or address already in use.'), 422: error('Validation failed.'), ...AUTH_ERRORS } },
    },
    '/servers/{id}': {
      parameters: [idParam],
      patch: { tags: ['Servers'], summary: 'Change weight, drain or re-enable a server', description: 'Set `enabled` to false to drain: current listeners stay, no new ones arrive. The built-in server accepts only `weight` and `enabled`.', requestBody: { required: true, content: json(ref('ServerPatch')) }, responses: { 200: ok('The updated server.', ref('Server')), 404: error('No such server.'), 422: error('Validation failed.'), ...AUTH_ERRORS } },
      delete: { tags: ['Servers'], summary: 'Remove a server', description: 'Its listeners are disconnected and reconnect to the remaining servers. The built-in server cannot be removed; drain it instead.', responses: { 204: { description: 'Removed.' }, 404: error('No such server, or it is the built-in one.'), ...AUTH_ERRORS } },
    },
    '/servers/{id}/audio-status': {
      parameters: [idParam],
      put: {
        tags: ['Servers'], summary: 'Mark a server as having no audio, or return it to automatic',
        description: 'Each engine watches whether it can actually get audio from station sources. If it cannot while other servers can, it reports `no_audio` by itself: it fails its health check so no new listeners are sent to it, and releases the listeners it has so their players reconnect elsewhere. It returns to service by itself when a source works again.\n\nThis call sets the same state by hand, for example from your own monitoring. `no_audio` takes the server out within a few seconds and keeps it out until you send `auto`. Unlike draining, it also disconnects the server\'s current listeners.',
        requestBody: { required: true, content: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['no_audio', 'auto'] }, reason: { type: 'string', maxLength: 200, example: 'upstream network maintenance' } } }) },
        responses: { 200: ok('The server with its new audio state.', ref('Server')), 404: error('No such server.'), 422: error('Validation failed.'), ...AUTH_ERRORS },
      },
    },
    '/cluster/join-tokens': {
      get: { tags: ['Servers'], summary: 'List unused join tokens', description: 'Administrators only. Tokens that are still valid; the secret values are never shown again.', responses: { 200: ok('Open tokens.', { type: 'object', properties: { join_tokens: { type: 'array', items: ref('JoinToken') } } }), ...AUTH_ERRORS } },
      post: {
        tags: ['Servers'], summary: 'Create a join token for a new slave node',
        description: 'Administrators only. Returns the token once, with the ready-made command to run on the new server. A token works once and expires after an hour unless you say otherwise.',
        requestBody: { content: json({ type: 'object', properties: { note: { type: 'string', maxLength: 100 }, expires_minutes: { type: 'integer', default: 60, minimum: 1, maximum: 10080 }, max_uses: { type: 'integer', default: 1, minimum: 1, maximum: 100, description: 'Raise this to enrol several servers with one token.' } } }) },
        responses: { 201: ok('The token and install command.', ref('JoinTokenCreated')), 422: error('Validation failed.'), ...AUTH_ERRORS },
      },
    },
    '/cluster/join-tokens/{id}': {
      parameters: [idParam],
      delete: { tags: ['Servers'], summary: 'Revoke a join token', responses: { 204: { description: 'Revoked.' }, 404: error('No such token.'), ...AUTH_ERRORS } },
    },
    '/cluster/join': {
      post: {
        tags: ['Servers'], summary: 'Enrol a slave node (called by the engine itself)', security: [],
        description: 'Not called by people or integrations: a slave\'s engine calls this with its join token. The master registers the server with HAProxy and returns the Redis endpoint, Redis password and engine secret. Authenticated by the token alone.',
        requestBody: { required: true, content: json({ type: 'object', required: ['token', 'name'], properties: { token: { type: 'string' }, name: { type: 'string', description: 'The server\'s NODE_ID.' }, port: { type: 'integer', default: 3000 }, address: { type: 'string', description: 'Address the master should use to reach the engine. Defaults to where the request came from.' } } }) },
        responses: { 200: { description: 'Enrolled. The body carries credentials and is intended for the engine only.' }, 403: error('Token invalid, expired, used, or issued for another address.'), 409: error('Name or address already taken.'), 422: error('Validation failed.') },
      },
    },
    '/system/version': {
      get: {
        tags: ['Updates'], summary: 'Running version, update settings and what the updater last did',
        description: 'Administrators only. The gateway checks its repository every few hours; add `?refresh` to check now. `update_available` is null when it cannot be told (images built from source, or GitHub not reachable).',
        parameters: [{ name: 'refresh', in: 'query', schema: { type: 'string' }, allowEmptyValue: true }],
        responses: { 200: ok('Version and updater state.', ref('UpdateStatus')), ...AUTH_ERRORS },
      },
    },
    '/system/update-settings': {
      put: {
        tags: ['Updates'], summary: 'Turn automatic updates on or off and set the time',
        description: 'Administrators only. With `auto` on, the server checks once a day at `time` (the server\'s own clock) and installs a newer version if there is one. Slave nodes then follow the master\'s version by themselves.',
        requestBody: { required: true, content: json({ type: 'object', properties: { auto: { type: 'boolean' }, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', example: '04:15' } } }) },
        responses: { 200: ok('The new state.', ref('UpdateStatus')), 422: error('Validation failed.'), 503: error('The updater is not set up on this server.'), ...AUTH_ERRORS },
      },
    },
    '/system/update': {
      post: {
        tags: ['Updates'], summary: 'Install the latest version now',
        description: 'Administrators only. The update starts on the server within five minutes. It backs up the database, downloads the new version and restarts the services that changed; listeners are disconnected for a few seconds and reconnect. Follow progress in `updater.state` and `updater.message` of `GET /system/version`.',
        responses: { 202: ok('Accepted; the update will start shortly.', ref('UpdateStatus')), 409: error('Already on the latest version.'), 503: error('The update scheduler is not running on this server.'), ...AUTH_ERRORS },
      },
    },
    '/system/certificate': {
      get: {
        tags: ['Updates'], summary: 'The HTTPS certificate in use, and Let\'s Encrypt renewal',
        description: 'Administrators only. `certificate` is read from HAProxy, so it is what browsers and players are given; null with `TLS_MODE=external`. `trusted` is true for an unexpired certificate for `domain` from a certificate authority. With `mode` `letsencrypt`, `lets_encrypt` says what the renewal scheduler on the server last did: it obtains the certificate (retrying hourly until it succeeds), checks twice a day and renews 30 days before expiry.',
        responses: { 200: ok('Certificate and renewal state.', ref('CertificateStatus')), ...AUTH_ERRORS },
      },
    },
    '/system/certificate/renew': {
      post: {
        tags: ['Updates'], summary: 'Obtain or renew the Let\'s Encrypt certificate now',
        description: 'Administrators only. Acted on by the server within five minutes: without a certificate from Let\'s Encrypt yet, one is requested; otherwise the current one is renewed even if not due. Let\'s Encrypt allows 5 certificates for the same name per week. Follow progress in `lets_encrypt.state` and `lets_encrypt.message` of `GET /system/certificate`.',
        responses: { 202: ok('Accepted.', ref('CertificateStatus')), 409: error('The certificate does not come from Let\'s Encrypt on this server.'), 503: error('The certificate scheduler is not running on this server.'), ...AUTH_ERRORS },
      },
    },
    '/capacity': {
      get: {
        tags: ['Servers'], summary: 'Resource use per server and whether another is needed',
        description: 'Administrators only. CPU, memory, disk and outbound traffic for every streaming server, refreshed every two seconds by each engine, plus an overall verdict. `add_server_recommended` turns true when any enabled server is at the critical level for CPU or memory, or the average across servers reaches the warning level. A server reports only if its name equals its engine\'s `NODE_ID`.',
        responses: { 200: ok('Capacity report.', ref('Capacity')), ...AUTH_ERRORS },
      },
    },
    '/capacity/estimate': {
      post: {
        tags: ['Servers'], summary: 'What adding a server would do',
        description: 'Administrators only. Given the size of a server, says how many listeners it could serve, how the installation\'s capacity changes and what limits it afterwards, and how today\'s listeners, the master\'s processor use and the master\'s traffic would be spread. A `proxied` server (a slave) takes over engine work but no traffic, since every listener still passes through the master; a `direct` server (an edge server) takes its listeners and their traffic away from the master.',
        requestBody: { required: true, content: json(ref('ServerCandidate')) },
        responses: { 200: ok('The estimate.', ref('CapacityEstimate')), 422: error('Validation failed.'), ...AUTH_ERRORS },
      },
    },
    '/billing': {
      get: {
        tags: ['Billing'], summary: 'What an account costs, and how close it is to its limits',
        description: 'A tenant receives their own account. An administrator receives one account with `user_id`, or every account with a total.',
        parameters: [{ name: 'user_id', in: 'query', schema: { type: 'integer' } }],
        responses: { 200: ok('The account\'s bill, or for an administrator without `user_id` an object with `accounts` and `monthly_total`.', ref('AccountBill')), ...AUTH_ERRORS },
      },
    },
    '/billing/quote': {
      get: {
        tags: ['Billing'], summary: 'Price a plan',
        description: 'What a number of listeners at a bitrate, and an amount of storage, cost per month at the current rates.',
        parameters: [
          { name: 'listeners', in: 'query', schema: { type: 'integer' }, description: 'For a plan by listeners.' },
          { name: 'bandwidth_gb', in: 'query', schema: { type: 'number' }, description: 'For a plan by bandwidth. One of the two is required.' },
          { name: 'bitrate_kbps', in: 'query', schema: { type: 'integer', default: 128 } },
          { name: 'storage_mb', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'discount_percent', in: 'query', schema: { type: 'number' }, description: 'Administrators only.' },
        ],
        responses: { 200: ok('The quote.', ref('Quote')), ...AUTH_ERRORS },
      },
    },
    '/billing/history': {
      get: {
        tags: ['Billing'], summary: 'Month by month',
        description: 'For each of the account\'s stations, every month on record: data sent, most listeners at once, listening hours. A bandwidth plan starts each month from nothing; the months before it stay here.',
        parameters: [{ name: 'months', in: 'query', schema: { type: 'integer', default: 12, maximum: 120 } }, { name: 'user_id', in: 'query', schema: { type: 'integer' }, description: 'Administrators only.' }],
        responses: { 200: ok('History.', { type: 'object', properties: { user_id: { type: 'integer' }, months: { type: 'array', items: { type: 'object', properties: { station: { type: 'string' }, month: { type: 'string', example: '2026-09' }, gigabytes: { type: 'number' }, peak_listeners: { type: 'integer' }, listener_hours: { type: 'number' }, sessions: { type: 'integer' } } } } } }), ...AUTH_ERRORS },
      },
    },
    '/billing/rates': {
      get: { tags: ['Billing'], summary: 'The rates prices are worked out from', description: 'Administrators only. Includes the resulting price per listener at common bitrates.', responses: { 200: ok('Rates.', ref('Rates')), ...AUTH_ERRORS } },
      put: { tags: ['Billing'], summary: 'Change the rates', description: 'Administrators only. Only the supplied fields change. `server_monthly_cost: 0` leaves prices unset.', requestBody: { required: true, content: json(ref('RatesUpdate')) }, responses: { 200: ok('Saved.', ref('Rates')), 422: error('Validation failed.'), ...AUTH_ERRORS } },
    },
    '/stations/{slug}/limits': {
      parameters: [slugParam],
      get: { tags: ['Billing'], summary: 'One station against its limits', description: 'The station\'s plan, its use this month and its standing: what its owner watches.', responses: { 200: ok('The station\'s plan and use.', ref('StationBill')), 404: error('No such station.'), ...AUTH_ERRORS } },
    },
    '/settings/email/test': {
      post: { tags: ['Settings'], summary: 'Send a test email', description: 'Administrators only. Shows that the mail settings work.', requestBody: { required: true, content: json({ type: 'object', required: ['to'], properties: { to: { type: 'string', format: 'email' } } }) }, responses: { 200: ok('Sent.', { type: 'object', properties: { sent: { type: 'boolean' }, to: { type: 'string' } } }), 409: error('Email is not set up.'), 502: error('The mail server refused the message.'), ...AUTH_ERRORS } },
    },
    '/notifications': {
      get: { tags: ['Billing'], summary: 'Notices sent', description: 'Administrators only. The most recent first.', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } }], responses: { 200: ok('Notices.', { type: 'object', properties: { notifications: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, sent_at: { type: 'string', format: 'date-time' }, username: { type: 'string' }, station: { type: 'string', nullable: true }, kind: { type: 'string', enum: ['listeners', 'storage', 'subscription'] }, threshold: { type: 'integer' }, period: { type: 'string' }, recipient: { type: 'string' }, subject: { type: 'string' } } } } } }), ...AUTH_ERRORS } },
    },
    '/notifications/send': {
      post: {
        tags: ['Billing'], summary: 'Email an account a summary, on request',
        description: 'Administrators only. Sends the account a summary of where its stations stand now: listeners against what each subscription covers, pay as you go so far, storage and the month\'s total. Sent whatever the automatic notices are set to.',
        requestBody: { required: true, content: json({ type: 'object', properties: { user_id: { type: 'integer' }, station: { type: 'string', description: 'A station slug: its owner is written to.' } } }) },
        responses: { 200: ok('Sent.', { type: 'object', properties: { sent: { type: 'boolean' }, to: { type: 'string' } } }), 409: error('The account has no email address, or email is not set up.'), ...AUTH_ERRORS },
      },
    },
    '/notifications/run': {
      post: { tags: ['Billing'], summary: 'Send the notices that are due', description: 'Administrators only. They are otherwise sent every 10 minutes, unless automatic notices are switched off (`notices.automatic` in the settings), in which case this is how they are sent.', responses: { 200: ok('How many were sent.', { type: 'object', properties: { sent: { type: 'integer' }, error: { type: 'string' } } }), ...AUTH_ERRORS } },
    },
    '/api-keys': {
      get: { tags: ['Accounts'], summary: 'List API keys', description: 'Your own keys. Administrators may pass `user_id` (or `all`).', parameters: [{ name: 'user_id', in: 'query', schema: { type: 'string' } }], responses: { 200: ok('Keys, without their secret values.', { type: 'object', properties: { api_keys: { type: 'array', items: ref('ApiKey') } } }), ...AUTH_ERRORS } },
      post: { tags: ['Accounts'], summary: 'Create an API key', description: 'The full key is returned once, in this response only. Store it immediately.', requestBody: { required: true, content: json({ type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 50, example: 'WHMCS module' }, user_id: { type: 'integer', description: 'Administrators only: create the key for another account.' } } }) }, responses: { 201: ok('The new key, including its secret.', ref('ApiKeyCreated')), 422: error('Validation failed.'), ...AUTH_ERRORS } },
    },
    '/api-keys/{id}': {
      parameters: [idParam],
      delete: { tags: ['Accounts'], summary: 'Revoke an API key', responses: { 204: { description: 'Revoked. The key stops working immediately.' }, 404: error('No such key.'), ...AUTH_ERRORS } },
    },
    '/audit-log': {
      get: { tags: ['Accounts'], summary: 'Recent changes', description: 'Administrators only. Who created, changed, suspended or deleted what.', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } }], responses: { 200: ok('Newest first.', { type: 'object', properties: { entries: { type: 'array', items: ref('AuditEntry') } } }), ...AUTH_ERRORS } },
    },
    '/auth/login': {
      post: {
        tags: ['Session'], summary: 'Sign in with a username and password', security: [],
        requestBody: { required: true, content: json({ type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string', format: 'password' } } }) },
        responses: { 200: ok('A session token to send as `Authorization: Bearer`.', ref('Session')), 401: error('Wrong username or password.'), 429: error('Too many attempts from this address.') },
      },
    },
    '/auth/logout': { post: { tags: ['Session'], summary: 'End the current session', responses: { 204: { description: 'Signed out.' }, ...AUTH_ERRORS } } },
    '/auth/me': { get: { tags: ['Session'], summary: 'Who am I', responses: { 200: ok('The authenticated account.', ref('User')), ...AUTH_ERRORS } } },
    '/public/stations/{slug}/now-playing': {
      parameters: [slugParam],
      get: { tags: ['Public'], summary: 'What a station is playing', security: [], description: 'For web players and widgets; callable from any origin. Title, artist and artwork are what is on air; where the stream and the metadata URL supply none (or the station has no listeners), the station\'s own `default_title`, `default_artist` and image are given instead.', responses: { 200: ok('Now playing.', ref('NowPlaying')), 404: error('No such station, or it is suspended.') } },
    },
    '/probe': {
      post: {
        tags: ['Stations'], summary: 'Try a stream or a title address',
        description: 'A streaming server connects to the address, through the same checks as any source, and reports what it reads: for `stream`, the format, whether the stream carries titles and the title being sent; for `titles`, the title, artist and artwork found, and whether the artwork loads. Nothing is saved. Takes up to about ten seconds.',
        requestBody: { required: true, content: json({ type: 'object', required: ['kind', 'url'], properties: { kind: { type: 'string', enum: ['stream', 'titles'] }, url: { type: 'string', format: 'uri' } } }) },
        responses: {
          200: ok('What was read, or why it could not be (`ok: false` with `error`).', { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' }, content_type: { type: 'string' }, format: { type: 'string', nullable: true, example: 'MP3 44100 Hz stereo' }, bitrate_kbps: { type: 'integer', nullable: true }, name: { type: 'string', nullable: true }, carries_titles: { type: 'boolean' }, title: { type: 'string' }, artist: { type: 'string' }, artwork: { type: 'string' }, artwork_works: { type: 'boolean', nullable: true } } }),
          503: error('No streaming server is running (`no_streaming_server`).'), 504: error('The streaming server did not answer in time (`probe_timeout`).'), ...AUTH_ERRORS,
        },
      },
    },
    '/public/stations/{slug}/artwork': {
      parameters: [slugParam],
      get: { tags: ['Public'], summary: 'A station\'s uploaded image', security: [], description: 'The image set as the station\'s `artwork_file_id`, for players and web pages; callable and embeddable from any origin. With the `v` value the gateway hands out, the response may be cached for good; a new image has a new `v`.', parameters: [{ name: 'v', in: 'query', schema: { type: 'string' }, description: 'Names the image\'s content.' }], responses: { 200: { description: 'The image.', content: { 'image/jpeg': {}, 'image/png': {}, 'image/webp': {}, 'image/gif': {} } }, 404: error('No such station, or it has no uploaded image.') } },
    },
    '/public/converter': {
      get: { tags: ['Public'], summary: 'Where to get StreamNode Converter', security: [], description: 'StreamNode Converter is a desktop program for Windows and Linux that converts audio and video files into a stream\'s format on the owner\'s own computer. This gives the download addresses and the registry reference the downloads are published under.', responses: { 200: ok('The downloads.', { type: 'object', properties: { image: { type: 'string', example: 'ghcr.io/blacdev/streamnode/converter:latest' }, downloads: { type: 'object', additionalProperties: { type: 'object', properties: { url: { type: 'string' }, file: { type: 'string' } } } } } }) } },
    },
    '/public/converter/{platform}': {
      parameters: [{ name: 'platform', in: 'path', required: true, schema: { type: 'string', enum: ['windows', 'linux'] } }],
      get: { tags: ['Public'], summary: 'Download StreamNode Converter', security: [], description: 'The gateway fetches the download from the container registry and passes it on under its file name.', responses: { 200: { description: 'The download.', content: { 'application/zip': {}, 'application/gzip': {} } }, 404: error('Not published yet (`converter_not_published`), or an unknown platform.'), 502: error('The registry could not be reached (`converter_unavailable`).'), 503: error('Too many downloads at once (`busy`).') } },
    },
    '/stream-types': {
      get: { tags: ['Public'], summary: 'Supported stream types', security: [], description: 'The kinds of stream a station can supply and what is available on each: relaying, silence detection, fades, idents and fallback audio, and what uploaded files must be.', responses: { 200: ok('The stream types.', { type: 'object', properties: { stream_types: { type: 'array', items: ref('StreamType') } } }) } },
    },
    '/health': {
      get: { tags: ['Public'], summary: 'Service health', security: [], responses: { 200: ok('Healthy.', ref('Health')), 503: ok('Database or cache unavailable.', ref('Health')) } },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      Bearer: { type: 'http', scheme: 'bearer', description: 'An API key or a session token from /auth/login.' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'validation_failed' },
              message: { type: 'string' },
              details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
            },
          },
        },
      },
      Live: {
        type: 'object',
        properties: {
          online: { type: 'boolean', description: 'True while the gateway is connected to a source for this station, which happens only while it has listeners.' },
          listeners: { type: 'integer' },
          source: { type: 'string', enum: ['primary', 'backup', 'fallback'], nullable: true, description: '`fallback` while the station is playing its fallback file because neither stream has audio.' },
          stream_format: { ...ref('StreamFormat'), nullable: true },
          title: { type: 'string', nullable: true },
          artist: { type: 'string', nullable: true },
          artwork: { type: 'string', nullable: true },
          title_from: { type: 'string', nullable: true, enum: ['metadata_url', 'stream', 'station', 'file', null], description: 'Where the title and artist come from.' },
          content_type: { type: 'string', nullable: true, example: 'audio/mpeg' },
          bitrate: { type: 'integer', nullable: true, description: 'kbps as announced by the source.', example: 96 },
          connected_since: { type: 'string', format: 'date-time', nullable: true },
          servers: { type: 'integer', description: 'Streaming servers currently relaying this station.' },
          no_audio_on: { type: 'array', description: 'Servers that currently get no audio from this station\'s sources. Such a server has released the station\'s listeners and resources and refuses the station until it retries (every 30 seconds while listeners ask for it); listeners are served by the other servers.', items: { type: 'object', properties: { server: { type: 'string', example: 'edge-2' }, since: { type: 'string', format: 'date-time' }, reason: { type: 'string', example: 'primary: source answered HTTP 404' } } } },
          source_offline: { type: 'boolean', description: 'true when every server has found the station\'s sources silent, i.e. the station itself is off the air.' },
        },
      },
      ServerCandidate: {
        type: 'object', required: ['vcpus', 'memory_gb', 'port_mbps'],
        properties: {
          vcpus: { type: 'number', example: 4 }, memory_gb: { type: 'number', example: 8 }, port_mbps: { type: 'number', example: 1000 },
          mode: { type: 'string', enum: ['proxied', 'direct'], default: 'proxied', description: '`proxied`: a slave behind the master. `direct`: an edge server with its own DNS record.' },
          bitrate_kbps: { type: 'number', default: 128 }, listeners: { type: 'number', description: 'The load to spread. Default: the listeners connected now.' },
        },
      },
      CapacityEstimate: {
        type: 'object',
        properties: {
          bitrate_kbps: { type: 'integer' }, listeners_now: { type: 'integer' },
          new_server: { type: 'object', description: 'The server as given, with `capacity`: the listeners it could serve and what limits it (`processor`, `memory` or `network`).' },
          capacity: { type: 'object', description: '`before` and `after`: `listeners` the installation can carry, how many of them `through_master`, and `limited_by`. `gained` is the difference.' },
          load_now: { type: 'object', description: '`before` and `after`: per server its `listeners` and `processor_percent`; for the `master` its `listeners_through_it`, `processor_percent`, `traffic_mbps` and `port_percent`.' },
          notes: { type: 'array', items: { type: 'string' }, description: 'The same, in sentences.' },
        },
      },
      CostModel: {
        type: 'object', description: 'What one listener costs, as measured on this installation. `measured: false` marks a starting figure not yet replaced by a measurement.',
        properties: Object.fromEntries(['engine', 'proxy'].map((part) => [part, { type: 'object', properties: { percent_of_core_per_1000_listeners: { type: 'number' }, kilobytes_per_listener: { type: 'integer' }, measured: { type: 'boolean' }, samples: { type: 'integer' } } }])),
      },
      StationBill: {
        type: 'object',
        properties: {
          station: { type: 'string' }, name: { type: 'string' }, is_active: { type: 'boolean' },
          plan: { type: 'object', properties: { max_listeners: { type: 'integer' }, listeners_billed: { type: 'integer' }, bitrate_kbps: { type: 'integer' }, bitrate_source: { type: 'string', enum: ['set', 'detected', 'default'] }, price_per_listener: { type: 'number' }, discount_percent: { type: 'number' }, price_override: { type: 'number', nullable: true }, subscription_ends_on: { type: 'string', format: 'date', nullable: true }, days_left: { type: 'integer', nullable: true } } },
          usage: {
            type: 'object',
            properties: {
              listeners_now: { type: 'integer' },
              percent_of_limit: { type: 'number', nullable: true, description: 'Listeners connected now, as a share of the limit. null for a station with no limit.' },
              peak_listeners_today: { type: 'integer' }, peak_listeners_last_7_days: { type: 'integer' }, peak_listeners_this_month: { type: 'integer' },
              peak_percent_today: { type: 'number', nullable: true }, peak_percent_last_7_days: { type: 'number', nullable: true }, peak_percent_this_month: { type: 'number', nullable: true },
              at_limit: {
                type: 'object', nullable: true, description: 'How long the station has actually been full: minutes in which it reached its limit. null for a station with no limit.',
                properties: { now: { type: 'boolean' }, minutes_today: { type: 'integer' }, minutes_last_7_days: { type: 'integer' }, minutes_this_month: { type: 'integer' }, last_reached_at: { type: 'string', format: 'date-time', nullable: true } },
              },
              bandwidth: {
                type: 'object', nullable: true, description: 'For a bandwidth plan: the month\'s data against its allowance.',
                properties: { allowance_gb: { type: 'number' }, used_gb: { type: 'number' }, remaining_gb: { type: 'number' }, over_gb: { type: 'number' }, percent_used: { type: 'number' }, projected_gb: { type: 'number', description: 'What the month comes to at its pace so far.' }, remaining_listener_hours: { type: 'integer', description: 'What is left, in listening at the station\'s bitrate.' } },
              },
              pay_as_you_go: {
                type: 'object', nullable: true, description: 'For a station on pay as you go: what it has had beyond its subscription. Each minute is charged on the most listeners it had.',
                properties: { active_now: { type: 'boolean' }, extra_listeners_now: { type: 'integer' }, minutes_this_month: { type: 'integer' }, most_extra_listeners: { type: 'integer' }, block_minutes: { type: 'integer', description: 'Lots of extra listeners, summed over the minutes.' }, last_at: { type: 'string', format: 'date-time', nullable: true } },
              },
              listener_hours_this_month: { type: 'number' }, gigabytes_this_month: { type: 'number' },
            },
          },
          status: { type: 'string', enum: ['ok', 'near_limit', 'pay_as_you_go', 'at_limit', 'out_of_bandwidth', 'expiring', 'expired'], description: '`near_limit`, `pay_as_you_go` (beyond the subscription and being charged) and `at_limit` describe the listeners connected at this moment, not a past peak; `usage.at_limit` and `usage.pay_as_you_go` have the history.' },
          pay_as_you_go_charge: { type: 'number', description: 'What listeners beyond the subscription have cost so far this month. 0 for a capped station.' },
          monthly_price: { type: 'number', nullable: true, description: 'null while prices are not set.' },
        },
      },
      AccountBill: {
        type: 'object',
        properties: {
          user_id: { type: 'integer' }, username: { type: 'string' }, email: { type: 'string', nullable: true }, currency: { type: 'string', example: 'USD' },
          prices_set: { type: 'boolean', description: 'false until the administrator has entered what a server costs.' }, month: { type: 'string', example: '2026-10' },
          stations: { type: 'array', items: ref('StationBill') },
          storage: { type: 'object', properties: { used_bytes: { type: 'integer' }, quota_bytes: { type: 'integer', nullable: true }, free_bytes: { type: 'integer', nullable: true }, percent_used: { type: 'number', nullable: true }, monthly_price: { type: 'number', nullable: true } } },
          discount_percent: { type: 'number' },
          monthly_total: { type: 'number', nullable: true, description: 'The subscriptions: stations and storage.' },
          pay_as_you_go_total: { type: 'number', description: 'What has been used beyond the subscriptions so far this month.' },
          total_so_far: { type: 'number', nullable: true, description: 'The two together.' },
        },
      },
      ListenerRate: { type: 'object', properties: { bitrate_kbps: { type: 'integer' }, listeners_per_server: { type: 'integer' }, limited_by: { type: 'string', enum: ['processor', 'memory', 'network'] }, cost_per_listener: { type: 'number' }, price_per_listener: { type: 'number' } } },
      Quote: { type: 'object', properties: { currency: { type: 'string' }, configured: { type: 'boolean' }, listeners: { type: 'integer' }, bitrate_kbps: { type: 'integer' }, storage_mb: { type: 'integer' }, rate: ref('ListenerRate'), listeners_price: { type: 'number' }, storage_price: { type: 'number' }, discount_percent: { type: 'number' }, monthly_total: { type: 'number' } } },
      RatesUpdate: {
        type: 'object',
        properties: {
          currency: { type: 'string', example: 'USD' }, server_monthly_cost: { type: 'number', description: 'What one server of the size below costs per month. 0 leaves prices unset.' },
          server_vcpus: { type: 'integer' }, server_memory_gb: { type: 'integer' }, server_port_mbps: { type: 'integer' },
          margin_percent: { type: 'number' }, storage_price_per_gb: { type: 'number' },
          payg_block_listeners: { type: 'integer', default: 10, description: 'Pay as you go: for every this many listeners over the subscription (a part counts as a whole)...' },
          payg_block_minutes: { type: 'integer', default: 1, description: '...for every this many minutes...' },
          payg_price_per_block: { type: 'number', description: '...this much is charged.' },
          payg_storage_price_per_gb: { type: 'number', description: 'Per gigabyte stored beyond the quota, per month, for accounts whose storage is on pay as you go.' },
          bandwidth_price_per_gb: { type: 'number', description: 'Per gigabyte of a bandwidth plan\'s monthly data. 0 works it out from the same costs as a listener\'s price.' },
          payg_bandwidth_price_per_gb: { type: 'number', description: 'Per gigabyte beyond a bandwidth plan, on pay as you go. 0 charges the same as inside the plan.' },
        },
      },
      Rates: { allOf: [ref('RatesUpdate'), { type: 'object', properties: { configured: { type: 'boolean' }, per_listener: { type: 'array', items: ref('ListenerRate') }, cost_model: ref('CostModel') } }] },
      StreamFeatures: {
        type: 'object', description: 'What the gateway can do with a stream of this type.',
        properties: {
          silence_detection: { type: 'boolean', description: 'A stream that stays connected but carries silence is treated as having no audio.' },
          fades: { type: 'boolean', description: 'Without an ident, changes of source fade out and in rather than cut.' },
          idents: { type: 'boolean' }, fallback_audio: { type: 'boolean' },
        },
      },
      StreamType: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['mp3', 'aac', 'he-aac', 'other', 'unsupported'] }, name: { type: 'string' }, description: { type: 'string' },
          relayed: { type: 'boolean', description: 'false: the gateway cannot relay this at all.' },
          features: ref('StreamFeatures'), files: { type: 'string', description: 'What an ident or fallback file must be for a stream of this type.' }, notes: { type: 'string' },
        },
      },
      StreamFormat: {
        type: 'object', description: 'What the streaming servers last saw the station\'s stream to be, and which features apply to it. Uploaded files must match it. null until the station has been on air.',
        properties: {
          type: { type: 'string', enum: ['mp3', 'aac', 'he-aac', 'other'], description: 'See `GET /stream-types`. `other` is relayed as it arrives.' },
          name: { type: 'string', example: 'MP3' }, summary: { type: 'string', example: 'MP3, 96 kbps, 44.1 kHz, stereo' },
          codec: { type: 'string', enum: ['mp3', 'aac'], nullable: true }, sample_rate: { type: 'integer', nullable: true, example: 44100 }, channels: { type: 'integer', nullable: true, example: 2 },
          bitrate_kbps: { type: 'integer', nullable: true, example: 96, description: 'null for a variable-bitrate stream, or when unknown.' }, variable_bitrate: { type: 'boolean' },
          content_type: { type: 'string', nullable: true, example: 'audio/mpeg' },
          level_db: { type: 'number', nullable: true, example: -16.2, description: 'The stream\'s average level in dB below full scale, known after about 20 seconds on air. Converted files are brought to it.' },
          features: ref('StreamFeatures'), notes: { type: 'string' },
        },
      },
      File: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, user_id: { type: 'integer' }, name: { type: 'string', example: 'Night mix' }, original_name: { type: 'string', nullable: true, example: 'night-mix.mp3' },
          size_bytes: { type: 'integer' }, kind: { type: 'string', enum: ['audio', 'image'] }, format: { type: 'string', example: 'MP3, 96 kbps, 44.1 kHz, stereo' },
          width: { type: 'integer', nullable: true, description: 'Images only, in pixels.' }, height: { type: 'integer', nullable: true },
          codec: { type: 'string', enum: ['mp3', 'aac', 'jpeg', 'png', 'webp', 'gif'], description: 'For an image, its type; the audio fields are then zero.' }, sample_rate: { type: 'integer' }, channels: { type: 'integer' },
          bitrate_kbps: { type: 'integer', description: 'Exact for constant-bitrate MP3, otherwise the average.' }, constant_bitrate: { type: 'boolean' },
          duration_seconds: { type: 'number' },
          stored_in: { type: 'string', enum: ['local', 'dropbox'] },
          status: { type: 'string', enum: ['ready', 'converting', 'failed'], description: '`converting`: described as it will be once converted, and not yet playable.' },
          status_detail: { type: 'string', nullable: true, description: 'Why a conversion failed.' },
          converted: { type: 'boolean', description: 'The stored audio is the gateway\'s conversion, not what was uploaded.' },
          gain_db: { type: 'number', nullable: true, description: 'How much a converted file was turned up or down to match the stream\'s loudness.' },
          used_by: { type: 'array', items: { type: 'object', properties: { station: { type: 'string' }, as: { type: 'string', enum: ['ident', 'fallback', 'artwork'] } } } },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      StorageUsage: { type: 'object', properties: { used_bytes: { type: 'integer' }, quota_bytes: { type: 'integer', nullable: true, description: 'null for administrators, who are not limited.' }, free_bytes: { type: 'integer', nullable: true } } },
      FileList: { type: 'object', properties: { files: { type: 'array', items: ref('File') }, usage: ref('StorageUsage'), limits: { type: 'object', properties: { ident_max_seconds: { type: 'integer' }, image_max_bytes: { type: 'integer' } } } } },
      SettingsUpdate: {
        type: 'object',
        properties: {
          ident_max_seconds: { type: 'integer', minimum: 1, maximum: 30, default: 5, description: 'Longest ident a station may use.' },
          default_storage_quota_mb: { type: 'integer', minimum: 0, default: 500, description: 'Upload space, in megabytes, for accounts without a quota of their own.' },
          dropbox_app_key: { type: 'string', nullable: true }, dropbox_app_secret: { type: 'string', nullable: true, description: 'Write-only.' },
        },
      },
      Settings: {
        type: 'object',
        properties: {
          ident_max_seconds: { type: 'integer' }, default_storage_quota_mb: { type: 'integer' },
          storage: {
            type: 'object',
            properties: {
              backend: { type: 'string', enum: ['local', 'dropbox'] },
              local: { type: 'object', properties: { files: { type: 'integer' }, bytes: { type: 'integer' } } },
              cache_mb: { type: 'integer', description: 'FILE_CACHE_MB: how much of what is in Dropbox is also kept on the server.' },
              dropbox: { type: 'object', properties: { app_key: { type: 'string', nullable: true }, app_secret_set: { type: 'boolean' }, connected: { type: 'boolean' }, account: { type: 'string', nullable: true }, files: { type: 'integer' }, bytes: { type: 'integer' }, redirect_uri: { type: 'string', description: 'Add this to the Dropbox app\'s redirect URIs.' } } },
            },
          },
        },
      },
      Station: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          slug: { type: 'string', example: 'powerbeats' },
          ...stationWritable,
          default_artwork_url: { type: 'string', nullable: true, description: 'Where the station\'s uploaded image can be fetched by anyone; null when it has none.', example: 'https://stream.example.com/api/v1/public/stations/powerbeats/artwork' },
          stream_url: { type: 'string', example: 'https://stream.example.com/powerbeats' },
          playlist_urls: { type: 'object', properties: { m3u: { type: 'string' }, pls: { type: 'string' } } },
          live: ref('Live'),
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      StationCreate: {
        type: 'object', required: ['name', 'slug', 'primary_url'],
        properties: { slug: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9_-]{0,48}[a-z0-9])?$', description: 'Becomes the public path of the stream.', example: 'powerbeats' }, ...stationWritable },
      },
      StationUpsert: { type: 'object', description: '`name` and `primary_url` are required when the station does not exist yet.', properties: stationWritable },
      StationPatch: { type: 'object', properties: { slug: { type: 'string', description: 'Administrators only.' }, ...stationWritable } },
      StationList: { type: 'object', properties: { total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' }, stations: { type: 'array', items: ref('Station') } } },
      StationStatus: { allOf: [ref('Live'), { type: 'object', properties: { station: { type: 'string' }, is_active: { type: 'boolean' }, max_listeners: { type: 'integer' } } }] },
      StatsPoint: {
        type: 'object',
        properties: {
          t: { type: 'string', format: 'date-time', description: 'Start of the bucket (UTC).' },
          bytes: { type: 'integer', description: 'Bytes sent to listeners.' },
          peak_listeners: { type: 'integer', description: 'Highest concurrent listener count.' },
          avg_listeners: { type: 'number', description: 'Average concurrent listeners across the bucket.' },
          listener_hours: { type: 'number', description: 'Total listening time.' },
          sessions: { type: 'integer', description: 'Listener connections started.' },
        },
      },
      StatsSeries: {
        type: 'object',
        properties: {
          station: { type: 'string' }, from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' },
          interval: { type: 'string', enum: ['minute', 'hour', 'day'] },
          totals: { type: 'object', properties: { bytes: { type: 'integer' }, peak_listeners: { type: 'integer' }, listener_hours: { type: 'number' }, sessions: { type: 'integer' } } },
          points: { type: 'array', items: ref('StatsPoint') },
        },
      },
      StationUsage: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' },
          station: { type: 'string' }, name: { type: 'string' }, user_id: { type: 'integer' }, external_id: { type: 'string', nullable: true },
          bytes: { type: 'integer' }, gigabytes: { type: 'number', description: 'bytes / 1,000,000,000' },
          peak_listeners: { type: 'integer' }, listener_hours: { type: 'number' }, sessions: { type: 'integer' },
        },
      },
      UsageReport: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' },
          totals: { type: 'object', properties: { bytes: { type: 'integer' }, gigabytes: { type: 'number' }, listener_hours: { type: 'number' }, sessions: { type: 'integer' } } },
          stations: { type: 'array', items: ref('StationUsage') },
        },
      },
      Metric: { type: 'object', properties: { station: { type: 'string' }, total_bytes: { type: 'integer' }, listeners: { type: 'integer' }, online: { type: 'boolean' }, source: { type: 'string', nullable: true } } },
      Overview: { type: 'object', properties: { stations: { type: 'integer' }, suspended_stations: { type: 'integer' }, stations_on_air: { type: 'integer' }, listeners_now: { type: 'integer' }, bytes_today: { type: 'integer' }, bytes_this_month: { type: 'integer' } } },
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, username: { type: 'string' }, role: { type: 'string', enum: ['admin', 'tenant'] },
          external_id: { type: 'string', nullable: true }, max_stations: { type: 'integer' }, is_active: { type: 'boolean' },
          station_count: { type: 'integer' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
        },
      },
      UserCreate: {
        type: 'object', required: ['username'],
        properties: {
          username: { type: 'string', example: 'client-1042' },
          password: { type: 'string', format: 'password', minLength: 10, description: 'Optional. Needed only if the account signs in to the dashboard.' },
          role: { type: 'string', enum: ['admin', 'tenant'], default: 'tenant' },
          external_id: { type: 'string', nullable: true, description: 'Your identifier for this customer, such as a billing client id.', example: 'whmcs-client-311' },
          max_stations: { type: 'integer', description: 'How many stations this account may create and manage. Defaults to DEFAULT_MAX_STATIONS (5). 0 means only administrators provision stations for it.' },
          storage_quota_mb: { type: 'integer', nullable: true, minimum: 0, description: 'Megabytes of uploaded audio the account may hold. null uses the default from the settings.' },
        },
      },
      UserPatch: { type: 'object', properties: { password: { type: 'string', format: 'password' }, role: { type: 'string', enum: ['admin', 'tenant'] }, external_id: { type: 'string', nullable: true }, max_stations: { type: 'integer' }, storage_quota_mb: { type: 'integer', nullable: true, description: 'null uses the default from the settings.' }, storage_overage: { type: 'boolean', description: 'Storage on pay as you go: uploads beyond the quota are allowed and charged.' }, storage_ceiling_mb: { type: 'integer', nullable: true, description: 'With that, the most the account may ever store. null for no ceiling.' }, is_active: { type: 'boolean' } } },
      ApiKey: { type: 'object', properties: { id: { type: 'integer' }, user_id: { type: 'integer' }, username: { type: 'string' }, name: { type: 'string' }, key_prefix: { type: 'string', example: 'rgw_3f9a01bc' }, last_used_at: { type: 'string', format: 'date-time', nullable: true }, created_at: { type: 'string', format: 'date-time' } } },
      ApiKeyCreated: { allOf: [ref('ApiKey'), { type: 'object', properties: { key: { type: 'string', description: 'The secret. Shown only once.' } } }] },
      AuditEntry: { type: 'object', properties: { id: { type: 'integer' }, at: { type: 'string', format: 'date-time' }, username: { type: 'string', nullable: true }, action: { type: 'string', example: 'station.suspend' }, target: { type: 'string', nullable: true }, detail: { type: 'object', nullable: true }, ip: { type: 'string' } } },
      Session: { type: 'object', properties: { token: { type: 'string' }, expires_in: { type: 'integer', description: 'Seconds.' }, user: ref('User') } },
      NowPlaying: { type: 'object', properties: { station: { type: 'string' }, name: { type: 'string' }, online: { type: 'boolean' }, title: { type: 'string', nullable: true }, artist: { type: 'string', nullable: true }, title_from: { type: 'string', nullable: true, enum: ['metadata_url', 'stream', 'station', 'file', null], description: 'Where the title and artist come from: the metadata URL, the playing stream, the station\'s own defaults, or the fallback file\'s name.' }, artwork: { type: 'string', nullable: true }, stream_url: { type: 'string' }, playlist_urls: { type: 'object', properties: { m3u: { type: 'string' }, pls: { type: 'string' } } } } },
      Server: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, name: { type: 'string', example: 'edge-2' }, mode: { type: 'string', enum: ['proxied', 'direct'], description: '`proxied`: listeners reach it through this gateway\'s HAProxy. `direct`: an edge server with its own public address in the domain\'s DNS records.' }, host: { type: 'string', example: '10.0.0.12' }, port: { type: 'integer', example: 3000 },
          weight: { type: 'integer', description: 'Relative share of new listeners, 1-256.' }, enabled: { type: 'boolean' }, is_builtin: { type: 'boolean' },
          state: { type: 'string', nullable: true, enum: ['UP', 'DOWN', 'DRAIN', 'MAINT', 'NOLB'], description: 'For proxied servers, as reported by HAProxy. For direct servers, UP while the engine is reporting.' },
          audio: { type: 'object', nullable: true, description: 'Whether the engine can deliver audio. null when it is not reporting.', properties: { status: { type: 'string', enum: ['ok', 'no_audio'] }, reason: { type: 'string', nullable: true, example: 'cannot get audio from the source of jazz, which another server is playing' }, since: { type: 'string', format: 'date-time', nullable: true }, forced: { type: 'boolean', description: 'true when set through the API rather than detected.' } } },
          resources: ref('Resources'),
          connections: { type: 'integer', nullable: true, description: 'Listener connections currently on this server.' },
          applied: { type: 'boolean', description: 'On writes: whether HAProxy accepted the change immediately.' },
          created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
        },
      },
      ServerCreate: { type: 'object', required: ['host'], properties: { setup_key: { type: 'string', description: 'The setup key printed by the slave installer. When present, `name` is not needed.' }, name: { type: 'string', description: 'Must equal the engine\'s NODE_ID.', example: 'edge-2' }, mode: { type: 'string', enum: ['proxied', 'direct'], default: 'proxied', description: 'For `direct`, `host` is the server\'s public address (for reference) and weight and draining do not apply.' }, host: { type: 'string', description: 'Hostname or IPv4 address of the engine, as reachable from this gateway.', example: '10.0.0.12' }, port: { type: 'integer', default: 3000 }, weight: { type: 'integer', default: 100, minimum: 1, maximum: 256 }, enabled: { type: 'boolean', default: true } } },
      ServerPatch: { type: 'object', properties: { name: { type: 'string' }, host: { type: 'string' }, port: { type: 'integer' }, weight: { type: 'integer' }, enabled: { type: 'boolean' } } },
      Resources: {
        type: 'object', nullable: true, description: 'null when the engine is not reporting.',
        properties: {
          status: { type: 'string', enum: ['ok', 'warning', 'critical'], description: 'The worst of CPU, memory and disk.' },
          cpu: { type: 'object', properties: { percent: { type: 'number', example: 34.5 }, cores: { type: 'integer' }, load_1m: { type: 'number' }, status: { type: 'string' } } },
          memory: { type: 'object', properties: { total_bytes: { type: 'integer' }, used_bytes: { type: 'integer' }, percent: { type: 'number' }, status: { type: 'string' } } },
          disk: { type: 'object', properties: { total_bytes: { type: 'integer' }, used_bytes: { type: 'integer' }, free_bytes: { type: 'integer' }, percent: { type: 'number' }, status: { type: 'string' } } },
          network_out_bps: { type: 'integer', description: 'Bytes per second leaving the engine.' },
          listeners: { type: 'integer' }, stations_on_air: { type: 'integer' }, uptime_seconds: { type: 'integer' },
          engine_version: { type: 'string' }, reported_at: { type: 'string', format: 'date-time' },
        },
      },
      Capacity: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'warning', 'critical'] },
          add_server_recommended: { type: 'boolean' },
          reasons: { type: 'array', items: { type: 'string' }, example: ['local: memory at 91.2%'] },
          averages: { type: 'object', properties: { cpu_percent: { type: 'number' }, memory_percent: { type: 'number' } } },
          thresholds: { type: 'object', properties: { warning_percent: { type: 'integer' }, critical_percent: { type: 'integer' } } },
          totals: { type: 'object', properties: { servers: { type: 'integer' }, servers_reporting: { type: 'integer' }, listeners: { type: 'integer' }, network_out_bps: { type: 'integer' } } },
          database: { type: 'object', properties: { size_bytes: { type: 'integer', description: 'Size of the PostgreSQL database on the gateway.' } } },
          servers: { type: 'array', items: { allOf: [ref('Server'), { type: 'object', properties: { resources: ref('Resources') } }] } },
        },
      },
      JoinToken: { type: 'object', properties: { id: { type: 'integer' }, token_prefix: { type: 'string', example: 'rgj_4be1a09c' }, note: { type: 'string', nullable: true }, bound_address: { type: 'string', nullable: true }, max_uses: { type: 'integer' }, uses: { type: 'integer' }, expires_at: { type: 'string', format: 'date-time' }, created_at: { type: 'string', format: 'date-time' } } },
      JoinTokenCreated: { allOf: [ref('JoinToken'), { type: 'object', properties: { token: { type: 'string', description: 'Shown only once.' }, master_url: { type: 'string' }, install_command: { type: 'string', description: 'Run on the new, empty server: it downloads the bootstrap script, installs what is needed and joins this master.', example: 'curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash -s -- --role slave --master https://stream.example.com --token rgj_…' } } }] },
      UpdateStatus: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' }, repository: { type: 'string', nullable: true }, branch: { type: 'string' },
          installed: { type: 'string', nullable: true, description: 'Commit the running images were built from.' },
          latest: { type: 'string', nullable: true },
          update_available: { type: 'boolean', nullable: true },
          checked_at: { type: 'string', format: 'date-time', nullable: true }, error: { type: 'string', nullable: true },
          settings: { type: 'object', properties: { auto: { type: 'boolean' }, time: { type: 'string', example: '04:15', description: 'Time of day on the server\'s clock.' } } },
          updater: {
            type: 'object',
            properties: {
              scheduler_running: { type: 'boolean', description: 'false means nothing happens by itself: the scheduler is not installed on the server.' },
              last_seen: { type: 'string', format: 'date-time', nullable: true },
              server_time: { type: 'string', nullable: true, example: '14:05' }, server_zone: { type: 'string', nullable: true, example: 'UTC' },
              state: { type: 'string', enum: ['idle', 'running', 'waiting', 'ok', 'failed'] },
              message: { type: 'string', nullable: true, example: 'Updated to 9a1e44f (scheduled).' },
              updated_at: { type: 'string', format: 'date-time', nullable: true },
              install_pending: { type: 'boolean', description: 'An "install now" request is waiting for the next scheduler pass.' },
            },
          },
        },
      },
      CertificateStatus: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['letsencrypt', 'provided', 'external', 'selfsigned'] },
          domain: { type: 'string', nullable: true },
          trusted: { type: 'boolean', description: 'An unexpired certificate for the domain from a certificate authority (not self-signed).' },
          error: { type: 'string', nullable: true, description: 'Why the certificate could not be read from HAProxy.' },
          certificate: {
            type: 'object', nullable: true,
            properties: {
              subject: { type: 'string' }, issuer: { type: 'string', example: "/C=US/O=Let's Encrypt/CN=R11" },
              names: { type: 'array', items: { type: 'string' } },
              not_before: { type: 'string', format: 'date-time', nullable: true }, expires_at: { type: 'string', format: 'date-time', nullable: true },
              days_left: { type: 'integer', nullable: true }, self_signed: { type: 'boolean' }, lets_encrypt: { type: 'boolean' },
            },
          },
          lets_encrypt: {
            type: 'object', nullable: true, description: 'Only with mode letsencrypt.',
            properties: {
              scheduler_running: { type: 'boolean', description: 'false means the certificate is neither obtained nor renewed by itself: the scheduler is not installed on the server.' },
              last_seen: { type: 'string', format: 'date-time', nullable: true },
              state: { type: 'string', enum: ['idle', 'running', 'ok', 'failed'] },
              message: { type: 'string', nullable: true },
              updated_at: { type: 'string', format: 'date-time', nullable: true },
              request_pending: { type: 'boolean' },
            },
          },
        },
      },
      Health: { type: 'object', properties: { status: { type: 'string', enum: ['ok', 'degraded'] }, database: { type: 'string' }, cache: { type: 'string' } } },
    },
  },
};
