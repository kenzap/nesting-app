'use strict';

(function defineNestConstants(globalScope) {
  const constants = {
    DEFAULT_ENGRAVING_COLOR: '#4488FF',
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = constants;
  }

  globalScope.NestConstants = constants;
})(typeof window !== 'undefined' ? window : globalThis);
