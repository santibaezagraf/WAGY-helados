import { describe, it, expect } from 'vitest'
import {
    normalizarRol,
    rolDeUser,
    puede,
    rutaExigeAdmin,
    aMailInterno,
    nombreDeMail,
    validarNombreUsuario,
    validarPassword,
    ROLES,
    type Accion,
    type Rol,
} from './rol'

describe('normalizarRol', () => {
    it('reconoce el literal exacto', () => {
        expect(normalizarRol('admin')).toBe('admin')
        expect(normalizarRol('mensajero')).toBe('mensajero')
    })

    // El caso que importa: cualquier cosa rara cae al rol SIN privilegios.
    // Un fail-open acá convierte un typo en app_metadata en un admin de más.
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['string vacío', ''],
        ['capitalizado', 'Admin'],
        ['mayúsculas', 'ADMIN'],
        ['con espacio adelante', ' admin'],
        ['con espacio atrás', 'admin '],
        ['otro rol', 'root'],
        ['número', 0],
        ['objeto', {}],
        ['array', ['admin']],
        ['booleano', true],
    ])('fail-closed: %s -> mensajero', (_caso, valor) => {
        expect(normalizarRol(valor)).toBe('mensajero')
    })
})

describe('rolDeUser', () => {
    it('sin usuario devuelve null (no hay sesión)', () => {
        expect(rolDeUser(null)).toBeNull()
        expect(rolDeUser(undefined)).toBeNull()
    })

    it('usuario sin app_metadata cae a mensajero', () => {
        expect(rolDeUser({})).toBe('mensajero')
        expect(rolDeUser({ app_metadata: null })).toBe('mensajero')
        expect(rolDeUser({ app_metadata: {} })).toBe('mensajero')
    })

    it('lee el rol de app_metadata', () => {
        expect(rolDeUser({ app_metadata: { rol: 'admin' } })).toBe('admin')
        expect(rolDeUser({ app_metadata: { rol: 'mensajero' } })).toBe('mensajero')
    })
})

describe('puede', () => {
    const TODAS: Accion[] = [
        'pedidos.ver', 'balances.ver', 'modelos.ver', 'chat.ver', 'actividad.ver',
        'pedidos.escribir', 'envio.escribir', 'gastos.escribir', 'precios.escribir',
        'chat.escribir', 'chat.moderar', 'alertas.resolver', 'perfil.editar',
    ]

    // Lo único que el mensajero puede hacer. Si alguien agrega una acción nueva
    // y la habilita para mensajero sin querer, este test lo caza.
    const DEL_MENSAJERO: Accion[] = ['pedidos.ver', 'envio.escribir', 'perfil.editar']

    it('el admin puede todo', () => {
        for (const accion of TODAS) {
            expect(puede('admin', accion), accion).toBe(true)
        }
    })

    it('el mensajero solo puede ver pedidos, tocar el costo de envío y su perfil', () => {
        for (const accion of TODAS) {
            expect(puede('mensajero', accion), accion).toBe(DEL_MENSAJERO.includes(accion))
        }
    })

    it('sin rol no se puede nada, ni siquiera leer', () => {
        for (const accion of TODAS) {
            expect(puede(null, accion), accion).toBe(false)
            expect(puede(undefined, accion), accion).toBe(false)
        }
    })

    it('la tabla de permisos cubre todas las acciones declaradas', () => {
        // Si se agrega una Accion al tipo y se olvida ponerla en PERMISOS,
        // `puede` explotaría en runtime al hacer PERMISOS[accion].includes.
        for (const accion of TODAS) {
            expect(() => puede('admin', accion)).not.toThrow()
        }
    })

    it('ROLES lista exactamente los roles del tipo', () => {
        const esperados: Rol[] = ['admin', 'mensajero']
        expect([...ROLES].sort()).toEqual([...esperados].sort())
    })
})

describe('rutaExigeAdmin', () => {
    it.each(['/balances', '/modelos', '/conversaciones'])('%s exige admin', (ruta) => {
        expect(rutaExigeAdmin(ruta)).toBe(true)
    })

    it('matchea subrutas', () => {
        expect(rutaExigeAdmin('/balances/2026')).toBe(true)
        expect(rutaExigeAdmin('/conversaciones/5491122334455')).toBe(true)
    })

    // El prefijo suelto NO debe matchear: mismo criterio que esRutaPublica en proxy.ts.
    it.each(['/balances-falsos', '/modelosx', '/conversacionesabc'])(
        '%s NO exige admin (prefijo sin barra)',
        (ruta) => {
            expect(rutaExigeAdmin(ruta)).toBe(false)
        },
    )

    it('las rutas de los dos roles no exigen admin', () => {
        expect(rutaExigeAdmin('/')).toBe(false)
        expect(rutaExigeAdmin('/perfil')).toBe(false)
        expect(rutaExigeAdmin('/login')).toBe(false)
        expect(rutaExigeAdmin('/precios')).toBe(false)
    })
})

describe('aMailInterno / nombreDeMail', () => {
    it('agrega el dominio interno al nombre', () => {
        expect(aMailInterno('juan')).toBe('juan@wagy.local')
    })

    it('normaliza espacios y mayúsculas', () => {
        expect(aMailInterno('  Juan  ')).toBe('juan@wagy.local')
        expect(aMailInterno('SOFIA')).toBe('sofia@wagy.local')
    })

    it('respeta un mail real tal cual (solo normalizado)', () => {
        expect(aMailInterno('alguien@gmail.com')).toBe('alguien@gmail.com')
        expect(aMailInterno('  Alguien@Gmail.com ')).toBe('alguien@gmail.com')
    })

    it('vuelve del mail al nombre', () => {
        expect(nombreDeMail('juan@wagy.local')).toBe('juan')
        expect(nombreDeMail('alguien@gmail.com')).toBe('alguien')
    })

    it('ida y vuelta es idempotente para un nombre', () => {
        expect(nombreDeMail(aMailInterno('juan'))).toBe('juan')
        expect(nombreDeMail(aMailInterno(' JUAN '))).toBe('juan')
    })

    it('tolera mail ausente o sin arroba', () => {
        expect(nombreDeMail(null)).toBe('')
        expect(nombreDeMail(undefined)).toBe('')
        expect(nombreDeMail('')).toBe('')
        expect(nombreDeMail('suelto')).toBe('suelto')
    })
})

describe('validarNombreUsuario', () => {
    it.each(['juan', 'sofia.g', 'pedro_2', 'ana-maria', 'abc'])('acepta %s', (nombre) => {
        expect(validarNombreUsuario(nombre)).toBeNull()
    })

    it('acepta con espacios alrededor (los recorta)', () => {
        expect(validarNombreUsuario('  juan  ')).toBeNull()
        expect(validarNombreUsuario('JUAN')).toBeNull()
    })

    it('rechaza vacío', () => {
        expect(validarNombreUsuario('')).toBeTruthy()
        expect(validarNombreUsuario('   ')).toBeTruthy()
    })

    it('rechaza demasiado corto o demasiado largo', () => {
        expect(validarNombreUsuario('ab')).toBeTruthy()
        expect(validarNombreUsuario('a'.repeat(31))).toBeTruthy()
        expect(validarNombreUsuario('a'.repeat(30))).toBeNull()
    })

    // El nombre termina siendo la parte local de un mail: nada de espacios,
    // arrobas ni acentos, o el login queda inconsistente.
    it.each(['juan perez', 'juan@wagy.local', 'josé', 'juan/perez', 'juan+1', 'ñoño'])(
        'rechaza %s',
        (nombre) => {
            expect(validarNombreUsuario(nombre)).toBeTruthy()
        },
    )
})

describe('validarPassword', () => {
    it('acepta 8 o más caracteres', () => {
        expect(validarPassword('12345678')).toBeNull()
        expect(validarPassword('una-contrasenia-larga')).toBeNull()
    })

    it('rechaza menos de 8', () => {
        expect(validarPassword('')).toBeTruthy()
        expect(validarPassword('1234567')).toBeTruthy()
    })
})
