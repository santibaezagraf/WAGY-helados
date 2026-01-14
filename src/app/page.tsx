import { createClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import { DataTable } from '@/components/pedidos/data-table'
import { Header } from '@/components/ui/header'


export default async function Home() {
    const supabase = await createClient();

    const  {data: { user } } = await supabase.auth.getUser();

    if (!user) {
        redirect('/login')
    }

    const { data: pedidos, error } = await supabase
        .from('pedidos')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return ( 
            <div>Error al cargar los pedidos: {error.message}</div>
        );
    }

    return (
        <div className="flex min-h-screen flex-col">
            <Header />
            <main className="flex-1 p-6 sm:p-8 lg:p-12 bg-slate-50">
                <div className="max-w-7xl mx-auto">
                    <DataTable data={pedidos || []} />
                </div>
            </main>
        </div>
    )
}