(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./navigator_location_core.js'));
  } else {
    root.NavigatorLocationWidget = factory(root.NavigatorLocationCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  if (!Core) throw new Error('NavigatorLocationCore is required');

  function resolveElement(value, requiredName) {
    if (!value) return null;
    if (typeof value === 'string') {
      var element = document.querySelector(value);
      if (!element && requiredName) throw new Error(requiredName + ' not found: ' + value);
      return element;
    }
    return value;
  }

  function debounce(fn, delay) {
    var timer = null;
    function wrapped() {
      var args = arguments;
      var context = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(context, args); }, delay);
    }
    wrapped.cancel = function () { clearTimeout(timer); };
    return wrapped;
  }

  function safeCall(callback) {
    if (typeof callback !== 'function') return undefined;
    var args = Array.prototype.slice.call(arguments, 1);
    try { return callback.apply(null, args); } catch (error) {
      console.error('[NavigatorLocationWidget] callback failed', error);
      return undefined;
    }
  }

  function createResultList(anchor, existingList, id) {
    if (existingList) return existingList;
    var list = document.createElement('ul');
    list.id = id;
    list.className = 'navigator-location-results';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    anchor.insertAdjacentElement('afterend', list);
    return list;
  }

  function NavigatorLocationWidget(options) {
    options = options || {};
    this.options = {
      cityInput: options.cityInput,
      streetInput: options.streetInput,
      houseInput: options.houseInput || null,
      resultList: options.resultList || null,
      statusElement: options.statusElement || null,
      form: options.form || null,
      settlementIndex: options.settlementIndex,
      streetService: options.streetService,
      cityLimit: Number(options.cityLimit || 15),
      streetLimit: Number(options.streetLimit || 8),
      cityMinChars: Number(options.cityMinChars || 2),
      streetMinChars: Number(options.streetMinChars || 3),
      debounceMs: Number(options.debounceMs || 300),
      manageCity: options.manageCity !== false,
      manageStreet: options.manageStreet !== false,
      interceptLegacyEvents: options.interceptLegacyEvents === true,
      clearStreetOnCityChange: options.clearStreetOnCityChange !== false,
      requirePickedCityOnSubmit: options.requirePickedCityOnSubmit !== false,
      onCitySelected: options.onCitySelected,
      onCityInvalidated: options.onCityInvalidated,
      onStreetSelected: options.onStreetSelected,
      onStatus: options.onStatus,
      onError: options.onError,
      debug: options.debug === true,
      showZip: options.showZip === true
    };

    if (!this.options.settlementIndex) throw new Error('settlementIndex is required');
    if (this.options.manageStreet && !this.options.streetService) throw new Error('streetService is required when manageStreet=true');

    this.cityInput = resolveElement(this.options.cityInput, 'cityInput');
    this.streetInput = resolveElement(this.options.streetInput, 'streetInput');
    this.houseInput = resolveElement(this.options.houseInput);
    this.statusElement = resolveElement(this.options.statusElement);
    this.form = resolveElement(this.options.form);
    this.resultList = createResultList(this.cityInput, resolveElement(this.options.resultList), 'navigator-location-results');

    this.selectedCity = null;
    this.mode = null;
    this.results = [];
    this.activeIndex = -1;
    this.destroyed = false;
    this.listeners = [];

    this._searchCityDebounced = debounce(this._searchCity.bind(this), this.options.debounceMs);
    this._searchStreetDebounced = debounce(this._searchStreet.bind(this), this.options.debounceMs);
    this._bind();
  }

  NavigatorLocationWidget.prototype._log = function () {
    if (!this.options.debug || typeof console === 'undefined') return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[NavigatorLocationWidget]');
    console.log.apply(console, args);
  };

  NavigatorLocationWidget.prototype._listen = function (element, eventName, handler, options) {
    element.addEventListener(eventName, handler, options);
    this.listeners.push(function () { element.removeEventListener(eventName, handler, options); });
  };

  NavigatorLocationWidget.prototype._guardLegacy = function (event) {
    if (!this.options.interceptLegacyEvents) return;
    event.stopImmediatePropagation();
  };

  NavigatorLocationWidget.prototype._bind = function () {
    var self = this;
    var capture = this.options.interceptLegacyEvents ? { capture: true } : false;

    if (this.options.manageCity) {
      this.cityInput.setAttribute('autocomplete', 'off');
      this.cityInput.setAttribute('role', 'combobox');
      this.cityInput.setAttribute('aria-autocomplete', 'list');
      this.cityInput.setAttribute('aria-controls', this.resultList.id);
      this.cityInput.setAttribute('aria-expanded', 'false');

      this._listen(this.cityInput, 'focus', function (event) {
        self._guardLegacy(event);
        self.mode = 'city';
        var query = self.cityInput.value.trim();
        if (Core.normalizeHu(query).length >= self.options.cityMinChars) self._searchCityDebounced(query);
      }, capture);

      this._listen(this.cityInput, 'input', function (event) {
        self._guardLegacy(event);
        self.mode = 'city';
        self._invalidateCityIfEdited();
        var query = self.cityInput.value.trim();
        if (Core.normalizeHu(query).length < self.options.cityMinChars) {
          self._searchCityDebounced.cancel();
          self.closeResults();
          self._setStatus('Írjon be legalább ' + self.options.cityMinChars + ' karaktert.', 'idle');
          return;
        }
        self._setStatus('Település keresése…', 'loading');
        self._searchCityDebounced(query);
      }, capture);

      this._listen(this.cityInput, 'keydown', function (event) {
        self._guardLegacy(event);
        self._handleKeydown(event);
      }, capture);
    }

    if (this.options.manageStreet && this.streetInput) {
      this.streetInput.setAttribute('autocomplete', 'off');
      this.streetInput.setAttribute('role', 'combobox');
      this.streetInput.setAttribute('aria-autocomplete', 'list');
      this.streetInput.setAttribute('aria-controls', this.resultList.id);
      this.streetInput.setAttribute('aria-expanded', 'false');

      this._listen(this.streetInput, 'focus', function (event) {
        self._guardLegacy(event);
        self.mode = 'street';
        if (!self.selectedCity) {
          self.closeResults();
          self._setStatus('Előbb válasszon települést a listából.', 'warning');
          return;
        }
        var query = self.streetInput.value.trim();
        if (Core.normalizeHu(query).length >= self.options.streetMinChars) self._searchStreetDebounced(query);
      }, capture);

      this._listen(this.streetInput, 'input', function (event) {
        self._guardLegacy(event);
        self.mode = 'street';
        if (!self.selectedCity) {
          self._searchStreetDebounced.cancel();
          self.closeResults();
          self._setStatus('Előbb válasszon települést a listából.', 'warning');
          return;
        }
        var query = self.streetInput.value.trim();
        if (Core.normalizeHu(query).length < self.options.streetMinChars) {
          self._searchStreetDebounced.cancel();
          self.closeResults();
          self._setStatus('Írjon be legalább ' + self.options.streetMinChars + ' karaktert az utcából.', 'idle');
          return;
        }
        self._setStatus('Utca keresése…', 'loading');
        self._searchStreetDebounced(query);
      }, capture);

      this._listen(this.streetInput, 'keydown', function (event) {
        self._guardLegacy(event);
        self._handleKeydown(event);
      }, capture);
    }

    this._listen(this.resultList, 'mousedown', function (event) {
      event.preventDefault();
    });

    this._listen(this.resultList, 'click', function (event) {
      var item = event.target.closest('[data-location-result-index]');
      if (!item) return;
      var index = Number(item.getAttribute('data-location-result-index'));
      self._pick(index);
    });

    this._listen(document, 'click', function (event) {
      if (event.target === self.cityInput || event.target === self.streetInput || self.resultList.contains(event.target)) return;
      self.closeResults();
    });

    if (this.form && this.options.requirePickedCityOnSubmit) {
      this._listen(this.form, 'submit', function (event) {
        var cityText = self.cityInput.value.trim();
        if (cityText && !self.selectedCity) {
          event.preventDefault();
          event.stopImmediatePropagation();
          self.cityInput.focus();
          self._setStatus('A települést válassza ki a találati listából.', 'error');
          safeCall(self.options.onError, { code: 'CITY_NOT_SELECTED', message: 'A település nincs kiválasztva.' });
        }
      }, { capture: true });
    }
  };

  NavigatorLocationWidget.prototype._invalidateCityIfEdited = function () {
    if (!this.selectedCity) return;
    if (Core.normalizeHu(this.cityInput.value) === Core.normalizeHu(this.selectedCity.name)) return;
    var previous = this.selectedCity;
    this.selectedCity = null;
    if (this.options.clearStreetOnCityChange && this.streetInput) this.streetInput.value = '';
    if (this.options.clearStreetOnCityChange && this.houseInput) this.houseInput.value = '';
    safeCall(this.options.onCityInvalidated, previous);
    this._log('CITY_INVALIDATED', previous);
  };

  NavigatorLocationWidget.prototype._searchCity = function (query) {
    if (this.destroyed) return;
    var results = this.options.settlementIndex.search(query, this.options.cityLimit);
    this.mode = 'city';
    this.results = results;
    this.activeIndex = -1;
    this._render();
    this._setStatus(results.length ? 'Válasszon települést a listából.' : 'Nem található település.', results.length ? 'ready' : 'warning');
  };

  NavigatorLocationWidget.prototype._searchStreet = function (query) {
    var self = this;
    if (this.destroyed || !this.selectedCity) return;
    this.options.streetService.search(query, this.selectedCity).then(function (outcome) {
      if (self.destroyed || self.mode !== 'street') return;
      self.results = (outcome.results || []).slice(0, self.options.streetLimit);
      self.activeIndex = -1;
      self._render();
      if (outcome.reason === 'aborted') return;
      if (self.results.length) {
        self._setStatus('Válasszon utcát a listából.' + (outcome.fromCache ? ' (gyorsítótár)' : ''), 'ready');
      } else if (outcome.reason === 'city_required') {
        self._setStatus('Előbb válasszon települést.', 'warning');
      } else if (outcome.reason === 'error') {
        self._setStatus('Az utcakeresés átmenetileg nem érhető el. Próbálja újra.', 'error');
        safeCall(self.options.onError, { code: 'STREET_SEARCH_ERROR', outcome: outcome });
      } else {
        self._setStatus('Nem találtunk utcát. Próbálja más névvel vagy jelölje ki a térképen.', 'warning');
      }
    });
  };

  NavigatorLocationWidget.prototype._render = function () {
    var self = this;
    this.resultList.innerHTML = '';
    if (!this.results.length) {
      this.closeResults();
      return;
    }
    this.results.forEach(function (result, index) {
      var item = document.createElement('li');
      item.className = 'navigator-location-result';
      item.id = self.resultList.id + '-option-' + index;
      item.setAttribute('role', 'option');
      item.setAttribute('data-location-result-index', String(index));
      item.setAttribute('aria-selected', 'false');

      var title = document.createElement('span');
      title.className = 'navigator-location-result-title';
      var meta = document.createElement('span');
      meta.className = 'navigator-location-result-meta';

      if (self.mode === 'city') {
        title.textContent = result.name;
        meta.textContent = (self.options.showZip ? [result.zip, result.county] : [result.county]).filter(Boolean).join(' · ');
      } else {
        title.textContent = result.street + (result.houseNumber ? ' ' + result.houseNumber : '');
        meta.textContent = [result.city, result.postcode, result.provider].filter(Boolean).join(' · ');
      }
      item.appendChild(title);
      item.appendChild(meta);
      self.resultList.appendChild(item);
    });
    this.resultList.hidden = false;
    this._setExpanded(true);
  };

  NavigatorLocationWidget.prototype._setExpanded = function (expanded) {
    var value = expanded ? 'true' : 'false';
    if (this.cityInput) this.cityInput.setAttribute('aria-expanded', value);
    if (this.streetInput) this.streetInput.setAttribute('aria-expanded', value);
  };

  NavigatorLocationWidget.prototype._handleKeydown = function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeResults();
      return;
    }
    if (!this.results.length || this.resultList.hidden) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (this.mode === 'city') this._searchCity(this.cityInput.value);
        else if (this.mode === 'street') this._searchStreet(this.streetInput.value);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex = (this.activeIndex + 1) % this.results.length;
      this._highlightActive();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex = (this.activeIndex - 1 + this.results.length) % this.results.length;
      this._highlightActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this._pick(this.activeIndex >= 0 ? this.activeIndex : 0);
    }
  };

  NavigatorLocationWidget.prototype._highlightActive = function () {
    var options = this.resultList.querySelectorAll('[role="option"]');
    for (var i = 0; i < options.length; i += 1) {
      var selected = i === this.activeIndex;
      options[i].classList.toggle('is-active', selected);
      options[i].setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) options[i].scrollIntoView({ block: 'nearest' });
    }
    var active = options[this.activeIndex];
    var input = this.mode === 'city' ? this.cityInput : this.streetInput;
    if (active) input.setAttribute('aria-activedescendant', active.id);
  };

  NavigatorLocationWidget.prototype._pick = function (index) {
    var result = this.results[index];
    if (!result) return;
    if (this.mode === 'city') this.selectCity(result);
    else this.selectStreet(result);
  };

  NavigatorLocationWidget.prototype.selectCity = function (city) {
    if (!city || !Number.isFinite(Number(city.lat)) || !Number.isFinite(Number(city.lng))) {
      this._setStatus('A település koordinátája hibás.', 'error');
      safeCall(this.options.onError, { code: 'INVALID_CITY_COORDINATES', city: city });
      return false;
    }
    this.selectedCity = {
      id: city.id,
      key: city.key,
      name: city.name,
      county: city.county,
      zip: city.zip,
      lat: Number(city.lat),
      lng: Number(city.lng),
      duplicateCount: city.duplicateCount || 1,
      sourceIds: city.sourceIds || [city.id]
    };
    this.cityInput.value = this.selectedCity.name;
    if (this.streetInput) this.streetInput.value = '';
    if (this.houseInput) this.houseInput.value = '';
    this.closeResults();
    this._setStatus('Település kiválasztva. Adja meg az utcát.', 'success');
    this._log('CITY_SELECTED', this.selectedCity);
    safeCall(this.options.onCitySelected, Object.assign({}, this.selectedCity));
    if (this.streetInput) this.streetInput.focus();
    return true;
  };

  NavigatorLocationWidget.prototype.selectStreet = function (result) {
    if (!result || !Number.isFinite(Number(result.lat)) || !Number.isFinite(Number(result.lng))) {
      this._setStatus('Az utca koordinátája hibás.', 'error');
      safeCall(this.options.onError, { code: 'INVALID_STREET_COORDINATES', result: result });
      return false;
    }
    this.streetInput.value = result.street || result.displayName || '';
    if (this.houseInput && result.houseNumber) this.houseInput.value = result.houseNumber;
    this.closeResults();
    this._setStatus('Cím kiválasztva, kérjük ellenőrizze.', 'success');
    this._log('STREET_SELECTED', result);
    safeCall(this.options.onStreetSelected, Object.assign({}, result), Object.assign({}, this.selectedCity));
    return true;
  };

  NavigatorLocationWidget.prototype.setSelectedCity = function (city) {
    return this.selectCity(city);
  };

  NavigatorLocationWidget.prototype.getState = function () {
    return {
      selectedCity: this.selectedCity ? Object.assign({}, this.selectedCity) : null,
      mode: this.mode,
      resultCount: this.results.length,
      activeIndex: this.activeIndex
    };
  };

  NavigatorLocationWidget.prototype._setStatus = function (message, kind) {
    if (this.statusElement) {
      this.statusElement.textContent = message || '';
      this.statusElement.setAttribute('data-location-status', kind || 'idle');
    }
    safeCall(this.options.onStatus, { message: message || '', kind: kind || 'idle' });
  };

  NavigatorLocationWidget.prototype.closeResults = function () {
    this.results = [];
    this.activeIndex = -1;
    this.resultList.innerHTML = '';
    this.resultList.hidden = true;
    this._setExpanded(false);
    if (this.cityInput) this.cityInput.removeAttribute('aria-activedescendant');
    if (this.streetInput) this.streetInput.removeAttribute('aria-activedescendant');
  };

  NavigatorLocationWidget.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this._searchCityDebounced.cancel();
    this._searchStreetDebounced.cancel();
    if (this.options.streetService && this.options.streetService.destroy) this.options.streetService.destroy();
    this.listeners.forEach(function (remove) { remove(); });
    this.listeners = [];
    this.closeResults();
  };

  return NavigatorLocationWidget;
});
