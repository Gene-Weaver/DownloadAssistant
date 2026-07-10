/*
 * Herbarium-code + filename derivation.
 *
 * A faithful JavaScript port of VoucherVision's `validate_herb_code` and
 * `generate_image_filename` (vouchervision/utils_GBIF.py). Herbarium codes are
 * not stored in a single reliable Darwin Core field, so we probe a priority
 * list and prefer a short (<=8 char) acronym, with a handful of institution
 * special-cases and manual overrides carried over verbatim.
 *
 * The canonical filename is case-sensitive and shaped:
 *     HERBCODE_gbifID_Family_Genus_specificEpithet.jpg
 *
 * Input `occ` is a GBIF occurrence record (JSON from api.gbif.org, whose id is
 * `occ.key`) OR a Darwin Core row (whose id is `occ.gbifID`) — both are handled.
 * `publisher` is the publishing organization's title (resolved separately from
 * occ.publishingOrgKey); it's only consulted as a late fallback.
 */

// Strip everything that isn't a filename-safe word char. Mirrors
// remove_illegal_chars: re.sub(r"[^a-zA-Z0-9_-]", "", text)
function removeIllegalChars(text) {
  return String(text == null ? '' : text).replace(/[^a-zA-Z0-9_-]/g, '');
}

// Keep only the first space-delimited token (e.g. "alba var. foo" -> "alba").
function keepFirstWord(text) {
  const s = String(text == null ? '' : text);
  return s.includes(' ') ? s.split(' ')[0] : s;
}

// Port of validate_herb_code(). Returns a best-guess herbarium code string.
function validateHerbCode(occ, publisher) {
  // Candidate columns, in the original priority order. publisher sits between
  // collectionCode and occurrenceID exactly as in the Python.
  const candidates = [
    occ.institutionCode,
    occ.institutionID,
    occ.ownerInstitutionCode,
    occ.collectionCode,
    publisher,
    occ.occurrenceID,
  ];
  const opts = candidates
    .filter((v) => v != null && String(v).trim() !== '')
    .map((v) => String(v));

  // Herbarium acronyms are short; anything <= 8 chars is a strong candidate.
  const optsShort = opts.filter((w) => w.length <= 8);

  let herbCode;
  if (optsShort.length === 0) {
    // No short acronym anywhere → fall back to the publisher name (dashed), or
    // "ERROR" if even that is absent. (Matches the Python's first branch.)
    herbCode = publisher ? String(publisher).replace(/ /g, '-') : 'ERROR';
  }

  const instID = occ.institutionID == null ? '' : String(occ.institutionID);
  const occID = occ.occurrenceID == null ? '' : String(occ.occurrenceID);

  if (instID === 'UBC Herbarium') herbCode = 'UBC';
  else if (instID === 'Naturalis Biodiversity Center') herbCode = 'L';
  else if (instID === 'Forest Herbarium Ibadan (FHI)') herbCode = 'FHI';
  else if (occID.includes('id.luomus.fi')) herbCode = 'FinBIF';
  else if (optsShort.length > 0) herbCode = optsShort[0];

  // Specific messy cases that require manual overrides. If you see a herbarium
  // DWC file with a similar error, add it here (kept identical to the Python).
  const overrides = {
    'Qarshi-Botanical-Garden,-Qarshi-Industries-Pvt.-Ltd,-Pakistan': 'Qarshi-Botanical-Garden',
    '12650': 'SDSU',
    '322': 'SDSU',
    'GC-University,-Lahore': 'GC-University-Lahore',
    'Institute-of-Biology-of-Komi-Scientific-Centre-of-the-Ural-Branch-of-the-Russian-Academy-of-Sciences': 'Komi-Scientific-Centre',
  };
  if (herbCode == null) herbCode = 'ERROR'; // safety; shouldn't be reachable
  if (Object.prototype.hasOwnProperty.call(overrides, herbCode)) {
    herbCode = overrides[herbCode];
  }
  return herbCode;
}

// Would validateHerbCode find a short acronym WITHOUT needing the publisher
// fallback? Lets the caller skip the extra organization API lookup in the common
// case (the vast majority of herbarium records carry an institutionCode).
function hasShortCodeWithoutPublisher(occ) {
  const candidates = [
    occ.institutionCode, occ.institutionID, occ.ownerInstitutionCode,
    occ.collectionCode, occ.occurrenceID,
  ];
  return candidates
    .filter((v) => v != null && String(v).trim() !== '')
    .some((v) => String(v).length <= 8);
}

// Port of generate_image_filename(). Returns the parts + assembled names.
function generateImageFilename(occ, publisher) {
  const herbCode = removeIllegalChars(validateHerbCode(occ, publisher));
  const specimenId = String(occ.key != null ? occ.key : (occ.gbifID != null ? occ.gbifID : ''));
  const family = removeIllegalChars(occ.family);
  const genus = removeIllegalChars(occ.genus);
  const species = removeIllegalChars(keepFirstWord(occ.specificEpithet));
  const fullname = [family, genus, species].join('_');

  const filenameImage = [herbCode, specimenId, fullname].join('_');
  const filenameJpg = `${filenameImage}.jpg`;

  return { herbCode, specimenId, family, genus, species, fullname, filenameImage, filenameJpg };
}

module.exports = {
  removeIllegalChars,
  keepFirstWord,
  validateHerbCode,
  hasShortCodeWithoutPublisher,
  generateImageFilename,
};
