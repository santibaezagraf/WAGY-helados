import { redirect } from 'next/navigation'
import { sesionActual } from '@/lib/auth-rol'
import { puede } from '@/lib/rol'
import { PanelBalances } from '@/components/balances/panel-balances'

/**
 * Wrapper de servidor de /balances.
 *
 * El cuerpo de la página es un client component y antes NO chequeaba nada por su
 * cuenta: dependía solo del middleware. Ahora hay dos capas más — este gate y el
 * `exigirPermiso('balances.ver')` de `obtenerBalance`/`ObtenerGastos`, que es el
 * que realmente protege los datos (la página se puede pedir, los datos no).
 */
export default async function BalancesPage() {
    const sesion = await sesionActual()
    if (!sesion) redirect('/login')
    if (!puede(sesion.rol, 'balances.ver')) redirect('/')

    return <PanelBalances />
}
