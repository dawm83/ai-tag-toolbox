'use strict';

function createCharacters(options = {}) {
  return require('./tag-library/character-adapter').createCharacterAdapter(options);
}

module.exports = { createCharacters };
