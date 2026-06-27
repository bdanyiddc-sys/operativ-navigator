(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NavigatorLocationCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0-lab';
  var DEFAULT_BOUNDS = { minLat: 45.4, maxLat: 49.1, minLng: 15.8, maxLng: 23.1 };
  var DEFAULT_ALIASES = {
    bp: 'budapest',
    pest: 'budapest',
    nyh: 'nyiregyhaza',
    szfv: 'szekesfehervar',
    fehervar: 'szekesfehervar',
    dvaros: 'dunaujvaros',
    dunaiv: 'dunaujvaros',
    hmvhely: 'hodmezovasarhely',
    hodmezo: 'hodmezovasarhely',
    moson: 'mosonmagyarovar',
    mvar: 'mosonmagyarovar'
  };

  function normalizeHu(value) {
    return String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[’'`´]/g, '')
      .replace(/[-_/.,;:()\[\]{}]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compactHu(value) {
    return normalizeHu(value).replace(/\s+/g, '');
  }

  function median(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    var radius = 6371;
    var p1 = lat1 * Math.PI / 180;
    var p2 = lat2 * Math.PI / 180;
    var dp = (lat2 - lat1) * Math.PI / 180;
    var dl = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * radius * Math.asin(Math.sqrt(a));
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function validateSettlement(row, bounds) {
    bounds = bounds || DEFAULT_BOUNDS;
    if (!row || typeof row !== 'object') return { ok: false, reason: 'not_object' };
    var name = String(row.name || '').trim();
    var county = String(row.county || '').trim();
    var zip = String(row.zip || '').trim();
    var lat = Number(row.lat);
    var lng = Number(row.lng);
    if (!name) return { ok: false, reason: 'missing_name' };
    if (!county) return { ok: false, reason: 'missing_county' };
    if (!zip) return { ok: false, reason: 'missing_zip' };
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, reason: 'invalid_coordinates' };
    if (lat < bounds.minLat || lat > bounds.maxLat || lng < bounds.minLng || lng > bounds.maxLng) {
      return { ok: false, reason: 'outside_hungary_bounds' };
    }
    return { ok: true };
  }

  function keyFor(row) {
    return [normalizeHu(row.name), normalizeHu(row.county), String(row.zip || '').trim()].join('|');
  }

  function buildCountyCentres(rows) {
    var buckets = Object.create(null);
    rows.forEach(function (row) {
      var county = String(row.county || '').trim();
      if (!buckets[county]) buckets[county] = [];
      buckets[county].push({ lat: Number(row.lat), lng: Number(row.lng) });
    });
    var result = Object.create(null);
    Object.keys(buckets).forEach(function (county) {
      result[county] = {
        lat: median(buckets[county].map(function (p) { return p.lat; })),
        lng: median(buckets[county].map(function (p) { return p.lng; }))
      };
    });
    return result;
  }

  function chooseDuplicateRepresentative(group, countyCentres) {
    if (group.length === 1) return group[0];
    var county = String(group[0].county || '').trim();
    var centre = countyCentres[county];
    if (!centre || !isFiniteNumber(centre.lat) || !isFiniteNumber(centre.lng)) {
      return group.slice().sort(function (a, b) { return Number(a.id || 0) - Number(b.id || 0); })[0];
    }
    return group.slice().sort(function (a, b) {
      var da = haversineKm(Number(a.lat), Number(a.lng), centre.lat, centre.lng);
      var db = haversineKm(Number(b.lat), Number(b.lng), centre.lat, centre.lng);
      if (da !== db) return da - db;
      return Number(a.id || 0) - Number(b.id || 0);
    })[0];
  }

  function isSubsequence(query, text) {
    if (!query || !text || query.length > text.length) return false;
    var qi = 0;
    for (var ti = 0; ti < text.length && qi < query.length; ti += 1) {
      if (query.charAt(qi) === text.charAt(ti)) qi += 1;
    }
    return qi === query.length;
  }

  function levenshtein(a, b, maxDistance) {
    a = String(a || '');
    b = String(b || '');
    if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
    var previous = new Array(b.length + 1);
    var current = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j += 1) previous[j] = j;
    for (var i = 1; i <= a.length; i += 1) {
      current[0] = i;
      var rowMin = current[0];
      for (var k = 1; k <= b.length; k += 1) {
        var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
        current[k] = Math.min(
          previous[k] + 1,
          current[k - 1] + 1,
          previous[k - 1] + cost
        );
        if (current[k] < rowMin) rowMin = current[k];
      }
      if (rowMin > maxDistance) return maxDistance + 1;
      var temp = previous;
      previous = current;
      current = temp;
    }
    return previous[b.length];
  }

  function buildSearchFields(row, aliases) {
    var normalizedName = normalizeHu(row.name);
    var compactName = compactHu(row.name);
    var words = normalizedName.split(/\s+/).filter(Boolean);
    var initials = words.map(function (word) { return word.charAt(0); }).join('');
    var rowAliases = [];
    Object.keys(aliases || {}).forEach(function (alias) {
      if (normalizeHu(aliases[alias]) === normalizedName) rowAliases.push(normalizeHu(alias));
    });
    return {
      normalizedName: normalizedName,
      compactName: compactName,
      words: words,
      initials: initials,
      aliases: rowAliases
    };
  }

  function scoreSettlement(item, rawQuery, aliases) {
    var q = normalizeHu(rawQuery);
    var compactQ = compactHu(rawQuery);
    if (!q) return -1;
    var aliasTarget = aliases && aliases[q] ? normalizeHu(aliases[q]) : null;
    if (aliasTarget && item._search.normalizedName === aliasTarget) return 12000;
    if (item._search.aliases.indexOf(q) !== -1) return 11800;
    if (item._search.normalizedName === q) return 11000;
    if (item._search.compactName === compactQ) return 10900;
    if (item._search.normalizedName.indexOf(q) === 0) return 10000 - item._search.normalizedName.length;
    if (item._search.compactName.indexOf(compactQ) === 0) return 9800 - item._search.compactName.length;
    if (item._search.words.some(function (word) { return word.indexOf(q) === 0; })) return 9000 - item._search.normalizedName.length;
    if (item._search.normalizedName.indexOf(q) !== -1) return 8000 - item._search.normalizedName.length;
    if (item._search.compactName.indexOf(compactQ) !== -1) return 7800 - item._search.compactName.length;
    if (q.length >= 2 && item._search.initials.indexOf(q) === 0) return 7000 - item._search.normalizedName.length;
    if (compactQ.length >= 4 && isSubsequence(compactQ, item._search.compactName)) {
      return 5000 - (item._search.compactName.length - compactQ.length);
    }
    if (compactQ.length >= 4) {
      var maxDistance = compactQ.length >= 7 ? 2 : 1;
      var candidate = item._search.compactName.slice(0, Math.max(compactQ.length, Math.min(item._search.compactName.length, compactQ.length + maxDistance)));
      var distance = levenshtein(compactQ, candidate, maxDistance);
      if (distance <= maxDistance) return 3500 - distance * 100 - item._search.compactName.length;
    }
    return -1;
  }

  function SettlementIndex(records, options) {
    options = options || {};
    this.options = {
      bounds: options.bounds || DEFAULT_BOUNDS,
      aliases: Object.assign({}, DEFAULT_ALIASES, options.aliases || {}),
      dedupe: options.dedupe !== false,
      maxResults: Number(options.maxResults || 15)
    };
    this.sourceCount = Array.isArray(records) ? records.length : 0;
    this.invalidRows = [];
    this.duplicateGroups = [];
    this.rows = [];
    this._build(Array.isArray(records) ? records : []);
  }

  SettlementIndex.prototype._build = function (records) {
    var valid = [];
    var self = this;
    records.forEach(function (row, index) {
      var validation = validateSettlement(row, self.options.bounds);
      if (!validation.ok) {
        self.invalidRows.push({ index: index, reason: validation.reason, row: row });
        return;
      }
      valid.push({
        id: row.id,
        name: String(row.name).trim(),
        county: String(row.county).trim(),
        zip: String(row.zip).trim(),
        lat: Number(row.lat),
        lng: Number(row.lng)
      });
    });

    var countyCentres = buildCountyCentres(valid);
    var groups = Object.create(null);
    valid.forEach(function (row) {
      var key = keyFor(row);
      if (!groups[key]) groups[key] = [];
      groups[key].push(row);
    });

    var output = [];
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      var selected = self.options.dedupe ? chooseDuplicateRepresentative(group, countyCentres) : group[0];
      if (group.length > 1) {
        self.duplicateGroups.push({
          key: key,
          count: group.length,
          selectedId: selected.id,
          sourceIds: group.map(function (row) { return row.id; }),
          candidates: group.map(function (row) {
            return { id: row.id, lat: row.lat, lng: row.lng };
          })
        });
      }
      var item = Object.assign({}, selected, {
        key: key,
        duplicateCount: group.length,
        sourceIds: group.map(function (row) { return row.id; })
      });
      item._search = buildSearchFields(item, self.options.aliases);
      output.push(item);
      if (!self.options.dedupe && group.length > 1) {
        group.slice(1).forEach(function (extra) {
          var extraItem = Object.assign({}, extra, {
            key: key + '|id:' + extra.id,
            duplicateCount: group.length,
            sourceIds: group.map(function (row) { return row.id; })
          });
          extraItem._search = buildSearchFields(extraItem, self.options.aliases);
          output.push(extraItem);
        });
      }
    });

    output.sort(function (a, b) {
      return a.name.localeCompare(b.name, 'hu', { sensitivity: 'base' }) ||
        a.county.localeCompare(b.county, 'hu', { sensitivity: 'base' }) ||
        a.zip.localeCompare(b.zip);
    });
    this.rows = output;
  };

  SettlementIndex.prototype.search = function (query, limit) {
    var q = normalizeHu(query);
    if (q.length < 2) return [];
    var max = Math.max(1, Math.min(Number(limit || this.options.maxResults), 50));
    var aliases = this.options.aliases;
    var scored = [];
    this.rows.forEach(function (row) {
      var score = scoreSettlement(row, query, aliases);
      if (score >= 0) scored.push({ row: row, score: score });
    });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.row.name.localeCompare(b.row.name, 'hu', { sensitivity: 'base' }) ||
        a.row.county.localeCompare(b.row.county, 'hu', { sensitivity: 'base' });
    });
    return scored.slice(0, max).map(function (entry) {
      var row = Object.assign({}, entry.row, { score: entry.score });
      delete row._search;
      return row;
    });
  };

  SettlementIndex.prototype.audit = function () {
    return {
      version: VERSION,
      sourceCount: this.sourceCount,
      validSourceCount: this.sourceCount - this.invalidRows.length,
      indexedCount: this.rows.length,
      invalidCount: this.invalidRows.length,
      duplicateGroupCount: this.duplicateGroups.length,
      duplicateExtraRecordCount: this.duplicateGroups.reduce(function (sum, group) { return sum + group.count - 1; }, 0),
      duplicateGroups: this.duplicateGroups.slice(),
      invalidRows: this.invalidRows.slice()
    };
  };

  SettlementIndex.load = function (url, options) {
    options = options || {};
    var fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : null) : null);
    if (!fetchImpl) return Promise.reject(new Error('fetch unavailable'));
    return fetchImpl(url, { headers: { Accept: 'application/json' }, cache: 'force-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('Settlement JSON load failed: HTTP ' + response.status);
        return response.json();
      })
      .then(function (records) { return new SettlementIndex(records, options); });
  };

  function createAbortError(message) {
    var error = new Error(message || 'aborted');
    error.name = 'AbortError';
    return error;
  }

  function withTimeout(fetchPromiseFactory, timeoutMs, externalSignal) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeoutId = null;
    var onAbort = null;
    if (externalSignal && externalSignal.aborted) return Promise.reject(createAbortError());
    if (controller && externalSignal) {
      onAbort = function () { controller.abort(); };
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    var signal = controller ? controller.signal : externalSignal;
    var promise = Promise.resolve().then(function () { return fetchPromiseFactory(signal); });
    var timeoutPromise = new Promise(function (_, reject) {
      timeoutId = setTimeout(function () {
        if (controller) controller.abort();
        var error = new Error('request_timeout');
        error.code = 'TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(function () {
      if (timeoutId) clearTimeout(timeoutId);
      if (externalSignal && onAbort) externalSignal.removeEventListener('abort', onAbort);
    });
  }

  function responseError(status, retryAfter) {
    var error = new Error('HTTP ' + status);
    error.status = status;
    error.retryAfter = retryAfter || null;
    return error;
  }

  function parseRetryAfter(response) {
    if (!response || !response.headers || !response.headers.get) return null;
    var value = response.headers.get('Retry-After');
    if (!value) return null;
    var seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    var date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }

  function normalizeNominatimRow(row, selectedCity) {
    if (!row || typeof row !== 'object') return null;
    var address = row.address || {};
    var street = address.road || address.pedestrian || address.square || address.footway || address.path || address.residential || row.name || '';
    var city = address.city || address.town || address.village || address.municipality || address.hamlet || (selectedCity && selectedCity.name) || '';
    var lat = Number(row.lat);
    var lng = Number(row.lon != null ? row.lon : row.lng);
    if (!street || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      provider: 'nominatim',
      street: String(street).trim(),
      houseNumber: String(address.house_number || '').trim(),
      city: String(city).trim(),
      postcode: String(address.postcode || (selectedCity && selectedCity.zip) || '').trim(),
      county: String(address.county || (selectedCity && selectedCity.county) || '').trim(),
      lat: lat,
      lng: lng,
      displayName: String(row.display_name || [street, city].filter(Boolean).join(', ')).trim(),
      raw: row
    };
  }

  function normalizePhotonFeature(feature, selectedCity) {
    if (!feature || feature.type !== 'Feature' || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) return null;
    var properties = feature.properties || {};
    var lng = Number(feature.geometry.coordinates[0]);
    var lat = Number(feature.geometry.coordinates[1]);
    var street = properties.street || properties.name || '';
    var city = properties.city || properties.town || properties.village || properties.locality || (selectedCity && selectedCity.name) || '';
    if (!street || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      provider: 'photon',
      street: String(street).trim(),
      houseNumber: String(properties.housenumber || '').trim(),
      city: String(city).trim(),
      postcode: String(properties.postcode || (selectedCity && selectedCity.zip) || '').trim(),
      county: String(properties.county || (selectedCity && selectedCity.county) || '').trim(),
      lat: lat,
      lng: lng,
      displayName: [properties.name || street, properties.city || city, properties.country].filter(Boolean).join(', '),
      raw: feature
    };
  }

  function cityMatches(result, selectedCity) {
    if (!selectedCity) return false;
    var expected = normalizeHu(selectedCity.name);
    var actual = normalizeHu(result.city);
    var display = normalizeHu(result.displayName);
    if (!expected) return false;
    return actual === expected || actual.indexOf(expected) !== -1 || expected.indexOf(actual) !== -1 || display.indexOf(expected) !== -1;
  }

  function streetMatches(result, query) {
    var q = normalizeHu(query);
    var street = normalizeHu(result.street);
    if (!q || !street) return false;
    if (street.indexOf(q) !== -1 || q.indexOf(street) !== -1) return true;
    var queryTokens = q.split(/\s+/).filter(function (token) { return token.length >= 2; });
    var streetTokens = street.split(/\s+/).filter(function (token) { return token.length >= 2; });
    return queryTokens.some(function (qt) {
      return streetTokens.some(function (st) { return st.indexOf(qt) === 0 || qt.indexOf(st) === 0; });
    });
  }

  function dedupeStreetResults(results, limit) {
    var seen = Object.create(null);
    var output = [];
    results.forEach(function (result) {
      if (output.length >= limit) return;
      var key = [normalizeHu(result.street), normalizeHu(result.city), result.houseNumber, result.lat.toFixed(5), result.lng.toFixed(5)].join('|');
      if (seen[key]) return;
      seen[key] = true;
      output.push(result);
    });
    return output;
  }

  function StreetSearchService(options) {
    options = options || {};
    this.options = {
      apiBase: String(options.apiBase || '').replace(/\/+$/, ''),
      primaryProvider: options.primaryProvider || null,
      fallbackProvider: options.fallbackProvider || null,
      allowDirectPhoton: options.allowDirectPhoton === true,
      photonUrl: options.photonUrl || 'https://photon.komoot.io/api/',
      minChars: Number(options.minChars || 3),
      limit: Number(options.limit || 8),
      cacheTtlMs: Number(options.cacheTtlMs || 5 * 60 * 1000),
      timeoutMs: Number(options.timeoutMs || 7000),
      cooldownMs: Number(options.cooldownMs || 15000),
      fetchImpl: options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : null) : null)
    };
    this.cache = new Map();
    this.inFlight = new Map();
    this.activeController = null;
    this.requestSequence = 0;
    this.primaryCooldownUntil = 0;
  }

  StreetSearchService.prototype._cacheKey = function (query, city) {
    return [city && city.key ? city.key : normalizeHu(city && city.name), normalizeHu(query)].join('|');
  };

  StreetSearchService.prototype._getCached = function (key) {
    var entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.value.map(function (row) { return Object.assign({}, row); });
  };

  StreetSearchService.prototype._setCached = function (key, value) {
    this.cache.set(key, { expiresAt: Date.now() + this.options.cacheTtlMs, value: value.map(function (row) { return Object.assign({}, row); }) });
  };

  StreetSearchService.prototype._defaultPrimary = function (query, city, signal) {
    if (!this.options.fetchImpl) return Promise.reject(new Error('fetch unavailable'));
    if (!this.options.apiBase) return Promise.reject(new Error('apiBase missing'));
    var fullQuery = [query, city.name, 'Magyarország'].filter(Boolean).join(', ');
    var url = this.options.apiBase + '/api/geocode/search?limit=' + encodeURIComponent(this.options.limit) +
      '&q=' + encodeURIComponent(fullQuery);
    var fetchImpl = this.options.fetchImpl;
    return withTimeout(function (innerSignal) {
      return fetchImpl(url, {
        signal: innerSignal,
        headers: { Accept: 'application/json', 'Accept-Language': 'hu' }
      }).then(function (response) {
        if (!response.ok) throw responseError(response.status, parseRetryAfter(response));
        return response.json();
      });
    }, this.options.timeoutMs, signal);
  };

  StreetSearchService.prototype._defaultPhoton = function (query, city, signal) {
    if (!this.options.fetchImpl) return Promise.reject(new Error('fetch unavailable'));
    var fullQuery = [query, city.name, 'Magyarország'].filter(Boolean).join(', ');
    var url = this.options.photonUrl + '?limit=' + encodeURIComponent(this.options.limit) + '&lang=hu&q=' + encodeURIComponent(fullQuery);
    var fetchImpl = this.options.fetchImpl;
    return withTimeout(function (innerSignal) {
      return fetchImpl(url, { signal: innerSignal, headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) throw responseError(response.status, parseRetryAfter(response));
          return response.json();
        });
    }, this.options.timeoutMs, signal);
  };

  StreetSearchService.prototype._normalizePayload = function (payload, selectedCity, providerName) {
    var rows = [];
    if (Array.isArray(payload)) {
      rows = payload.map(function (row) { return normalizeNominatimRow(row, selectedCity); });
    } else if (payload && Array.isArray(payload.features)) {
      rows = payload.features.map(function (feature) { return normalizePhotonFeature(feature, selectedCity); });
    } else if (payload && Array.isArray(payload.results)) {
      rows = payload.results.map(function (row) { return normalizeNominatimRow(row, selectedCity); });
    }
    return rows.filter(Boolean).map(function (row) {
      if (providerName) row.provider = providerName;
      return row;
    });
  };

  StreetSearchService.prototype._runProvider = function (provider, query, city, signal, providerName) {
    var self = this;
    var runner;
    if (provider) runner = function () { return provider(query, city, signal, self.options.limit); };
    else if (providerName === 'primary') runner = function () { return self._defaultPrimary(query, city, signal); };
    else runner = function () { return self._defaultPhoton(query, city, signal); };
    return Promise.resolve().then(runner).then(function (payload) {
      return self._normalizePayload(payload, city, providerName === 'primary' ? 'nominatim' : 'photon');
    });
  };

  StreetSearchService.prototype._shouldFallback = function (error, results) {
    if (results && results.length === 0) return true;
    if (!error) return false;
    return error.code === 'TIMEOUT' || error.name === 'AbortError' || error.status === 429 || error.status >= 500;
  };

  StreetSearchService.prototype.search = function (query, selectedCity) {
    var self = this;
    var cleanQuery = String(query || '').trim();
    if (!selectedCity) return Promise.resolve({ results: [], reason: 'city_required', fromCache: false });
    if (normalizeHu(cleanQuery).length < this.options.minChars) {
      return Promise.resolve({ results: [], reason: 'query_too_short', fromCache: false });
    }
    var key = this._cacheKey(cleanQuery, selectedCity);
    var cached = this._getCached(key);
    if (cached) return Promise.resolve({ results: cached, reason: 'ok', fromCache: true });
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    if (this.activeController) this.activeController.abort();
    this.activeController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var signal = this.activeController ? this.activeController.signal : null;
    var sequence = ++this.requestSequence;
    var primaryError = null;
    var canUsePrimary = Date.now() >= this.primaryCooldownUntil;

    var primaryPromise = canUsePrimary
      ? this._runProvider(this.options.primaryProvider, cleanQuery, selectedCity, signal, 'primary')
        .catch(function (error) {
          primaryError = error;
          if (error && error.status === 429) {
            self.primaryCooldownUntil = Date.now() + (error.retryAfter || self.options.cooldownMs);
          }
          return [];
        })
      : Promise.resolve([]);

    var promise = primaryPromise.then(function (primaryRows) {
      if (sequence !== self.requestSequence) throw createAbortError('stale_response');
      var filteredPrimary = dedupeStreetResults(primaryRows.filter(function (row) {
        return cityMatches(row, selectedCity) && streetMatches(row, cleanQuery);
      }), self.options.limit);
      if (filteredPrimary.length) return { rows: filteredPrimary, provider: 'primary' };

      var fallbackAvailable = !!self.options.fallbackProvider || self.options.allowDirectPhoton;
      if (!fallbackAvailable || !self._shouldFallback(primaryError, filteredPrimary)) {
        return { rows: [], provider: 'primary' };
      }
      return self._runProvider(self.options.fallbackProvider, cleanQuery, selectedCity, signal, 'fallback')
        .then(function (fallbackRows) {
          if (sequence !== self.requestSequence) throw createAbortError('stale_response');
          return {
            rows: dedupeStreetResults(fallbackRows.filter(function (row) {
              return cityMatches(row, selectedCity) && streetMatches(row, cleanQuery);
            }), self.options.limit),
            provider: 'fallback'
          };
        });
    }).then(function (outcome) {
      self._setCached(key, outcome.rows);
      return {
        results: outcome.rows,
        reason: outcome.rows.length ? 'ok' : 'not_found',
        provider: outcome.provider,
        fromCache: false,
        primaryError: primaryError ? { message: primaryError.message, status: primaryError.status || null, code: primaryError.code || null } : null
      };
    }).catch(function (error) {
      if (error && error.name === 'AbortError') return { results: [], reason: 'aborted', fromCache: false };
      return { results: [], reason: 'error', fromCache: false, error: error };
    }).finally(function () {
      self.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  };

  StreetSearchService.prototype.clearCache = function () {
    this.cache.clear();
  };

  StreetSearchService.prototype.destroy = function () {
    if (this.activeController) this.activeController.abort();
    this.cache.clear();
    this.inFlight.clear();
  };

  return {
    VERSION: VERSION,
    DEFAULT_ALIASES: Object.assign({}, DEFAULT_ALIASES),
    normalizeHu: normalizeHu,
    compactHu: compactHu,
    validateSettlement: validateSettlement,
    SettlementIndex: SettlementIndex,
    StreetSearchService: StreetSearchService,
    normalizeNominatimRow: normalizeNominatimRow,
    normalizePhotonFeature: normalizePhotonFeature,
    haversineKm: haversineKm
  };
});
