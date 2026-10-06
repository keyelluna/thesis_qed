function assertMappedCapacity(itemCount, capacity, label) {
  if (itemCount > capacity) {
    throw new Error(`${label} has ${capacity} official score slots but QED has ${itemCount} items. No columns were inserted; reduce or consolidate assessments before export.`);
  }
}

module.exports = { assertMappedCapacity };
