declare module 'fernet' {
  export class Fernet {
    constructor(key: string);
    encrypt(value: string): string;
    decrypt(token: string): string;
  }
  export default Fernet;
}
