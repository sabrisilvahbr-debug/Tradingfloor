# Modo real — Binance Spot com dinheiro de verdade

**Leia tudo antes de ligar.** No modo real o sistema compra e vende criptomoedas de verdade na
sua conta. Você pode perder parte ou todo o capital alocado.

## O que você precisa saber antes

1. **A estratégia não foi validada como lucrativa.** Na simulação ao vivo ela ficou levemente
   negativa. Cada operação paga cerca de 0,1% de taxa na compra e 0,1% na venda; os alvos da
   estratégia são pequenos, então as taxas pesam muito.
2. **Este código nunca rodou contra a Binance de verdade.** Foi testado contra uma corretora
   falsa. O primeiro teste real é o passo 4 abaixo, que não executa ordens.
3. **Os agentes decidem por regras fixas**, não por IA generativa.
4. **Ninguém vigia por você.** Se o computador desligar, as posições abertas continuam
   protegidas pelo stop que fica na Binance, mas o alvo deixa de ser acompanhado.

## O que o sistema faz e não faz

| Faz | Não faz |
|---|---|
| Compra à vista pares com USDT da lista monitorada | Venda a descoberto, margem, futuros, alavancagem |
| Usa no máximo o capital alocado (teto fixo de **100 USDT** no código) | Usar o resto do saldo da conta |
| Coloca o stop **na Binance** logo após cada compra | Saques ou transferências (não existe código para isso) |
| Vende tudo imediatamente se não conseguir colocar o stop | Aceitar chave de API com permissão de saque |
| Aciona o kill switch sozinho se ficar em dúvida sobre uma ordem | Mudar limites de risco pelo painel ou pelos agentes |

Com 100 USDT e os limites padrão: até 3 posições ao mesmo tempo, cada uma de no máximo
20 USDT, exposição total de no máximo 50 USDT. Novas operações param se a perda do dia
passar de 5% ou se a queda desde o pico passar de 15% do capital alocado.

## Passo a passo

1. **Tenha USDT na conta Spot da Binance** (pelo menos o capital que vai alocar).
2. **Crie a chave de API** na Binance (Perfil → Gerenciamento de API):
   - marque **"Habilitar leitura"** e **"Habilitar negociação Spot"**;
   - **NÃO marque saques**;
   - se possível, restrinja ao IP do computador/servidor onde o sistema roda.
3. **Preencha o arquivo `.env`** (no seu computador, nunca em conversa ou no GitHub): tire o
   `#` das linhas do bloco "MODO REAL" em `.env.example`, cole a chave e o segredo, e defina
   `TMF_ADMIN_TOKEN` com uma senha de pelo menos 12 caracteres.
4. **Rode a conferência, que não executa nenhuma ordem:**
   ```bash
   python -m backend.live_trading.check
   ```
   Só continue se terminar com "tudo certo para ligar o modo real".
5. **Ligue o sistema** normalmente. O topo da tela mostrará **DINHEIRO REAL — BINANCE SPOT**
   em vermelho. Se aparecer "PAPER TRADING", o modo real não está ligado.
6. **Acompanhe de perto os primeiros dias** e confira as ordens também no aplicativo da Binance.

## Como parar

- **Pausar autonomia** (topo da tela): não abre novas operações.
- **Kill switch** (aba Gestão de risco): bloqueia qualquer nova operação.
- **Fechar** (aba Carteira real): vende a posição a mercado.
- **Desligar de vez:** apague `TMF_LIVE_TRADING_ENABLED=true` do `.env` e reinicie. Se houver
  posições abertas, feche-as antes — ou venda pelo aplicativo da Binance e cancele os stops.

## Limitações conhecidas

- Comissões pagas em BNB (se você ativou esse desconto na Binance) aparecem separadas e
  **não entram** no resultado líquido calculado.
- Sobras minúsculas de moeda (abaixo do mínimo de venda) ficam na conta.
- O stop é do tipo "stop-limit": numa queda muito brusca ele pode não ser executado.
- Operar pode gerar obrigações de imposto. Consulte um contador.
