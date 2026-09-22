class KYCProvider {
  constructor(name = 'base') {
    this.name = name;
  }

  async ocrDocument() {
    throw new Error(`${this.name}.ocrDocument no implementado`);
  }

  async faceMatch() {
    throw new Error(`${this.name}.faceMatch no implementado`);
  }

  async liveness() {
    throw new Error(`${this.name}.liveness no implementado`);
  }

  async screenSanctions() {
    throw new Error(`${this.name}.screenSanctions no implementado`);
  }
}

module.exports = KYCProvider;
