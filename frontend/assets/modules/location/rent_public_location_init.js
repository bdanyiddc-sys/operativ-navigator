(function () {
  'use strict';

  function start() {
    var Core = window.NavigatorLocationCore;
    var Widget = window.NavigatorLocationWidget;
    var bridge = window.RentPublicLocationBridgeV1;
    if (!Core || !Widget || !bridge) {
      console.error('[NavigatorLocation] Missing Core, Widget or Rent bridge.');
      return;
    }

    var config = Object.assign({
      settlementUrl: '/assets/data/telepulesek_hu_final.json',
      allowDirectPhoton: false,
      photonProxyUrl: '',
      debug: true
    }, window.NAVIGATOR_LOCATION_CONFIG || {});

    function buildFallbackProvider() {
      if (!config.photonProxyUrl) return null;
      return function (query, city, signal, limit) {
        var url = config.photonProxyUrl +
          (config.photonProxyUrl.indexOf('?') === -1 ? '?' : '&') +
          'q=' + encodeURIComponent(query) +
          '&city=' + encodeURIComponent(city.name) +
          '&limit=' + encodeURIComponent(limit || 8);
        return fetch(url, {
          signal: signal,
          headers: { Accept: 'application/json', 'Accept-Language': 'hu' }
        }).then(function (response) {
          if (!response.ok) {
            var error = new Error('Fallback HTTP ' + response.status);
            error.status = response.status;
            throw error;
          }
          return response.json();
        });
      };
    }

    Core.SettlementIndex.load(config.settlementUrl, { dedupe: true, maxResults: 15 })
      .then(function (settlementIndex) {
        var audit = settlementIndex.audit();
        console.log('[NavigatorLocation] SETTLEMENT_DATA_READY', audit);

        var streetService = new Core.StreetSearchService({
          apiBase: bridge.getApiBase(),
          minChars: 3,
          limit: 8,
          cacheTtlMs: 5 * 60 * 1000,
          timeoutMs: 7000,
          cooldownMs: 15000,
          fallbackProvider: buildFallbackProvider(),
          allowDirectPhoton: config.allowDirectPhoton === true
        });

        var list = document.getElementById('addrSuggest');
        if (list) list.classList.add('navigator-location-managed');

        window.RentPublicLocationWidgetV1 = new Widget({
          cityInput: '#city',
          streetInput: '#street',
          houseInput: '#houseNumber',
          resultList: '#addrSuggest',
          statusElement: '#geoStatus',
          form: '#inquiryForm',
          settlementIndex: settlementIndex,
          streetService: streetService,
          cityMinChars: 2,
          streetMinChars: 3,
          cityLimit: 15,
          streetLimit: 8,
          debounceMs: 300,
          manageCity: true,
          manageStreet: true,
          interceptLegacyEvents: true,
          requirePickedCityOnSubmit: true,
          debug: config.debug === true,

          onCitySelected: function (city) {
            var snapshot = bridge.selectCity(city);
            console.log('CITY_SELECTED', city, snapshot);
          },

          onCityInvalidated: function (previousCity) {
            bridge.cityInputInvalidated(previousCity);
          },

          onStreetSelected: function (result, city) {
            var snapshot = bridge.selectStreet(result, city);
            console.log('STREET_SELECTED', result, snapshot);
          },

          onError: function (error) {
            console.error('[NavigatorLocation] ERROR', error);
          }
        });
      })
      .catch(function (error) {
        console.error('[NavigatorLocation] INIT_FAILED', error);
        var status = document.getElementById('geoStatus');
        if (status) status.textContent = 'A településlista nem tölthető be. Frissítse az oldalt.';
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
